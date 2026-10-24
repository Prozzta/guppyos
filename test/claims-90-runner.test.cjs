'use strict';
/**
 * CLAIMS-90 Phase 3 pins for the scoring runner (test/claims-90/): the snapshot check, the items
 * check, the containment checks, and the real-CLI shim passing argv through unchanged (spec 1b, 7).
 * The live answer run itself needs the frozen snapshot and the MAC key, so it is not run here.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { readSource, codeOnly } = require('./read-source.cjs');
const { parseItems, verifySnapshot, parseArgs } = require('./claims-90/run.cjs');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function tmpSnapshot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c90-snap-'));
  fs.mkdirSync(path.join(dir, 'hive'));
  fs.writeFileSync(path.join(dir, 'hive', 'a.jsonl'), 'one\n');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ hiveRoot: 'X:/hive', files: [{ path: 'hive/a.jsonl', group: 'retrieval', sha256: sha('one\n') }] }));
  return dir;
}

test('the snapshot check passes an intact copy and names a changed or missing file', () => {
  const dir = tmpSnapshot();
  assert.deepEqual(verifySnapshot(dir).diffs, []);
  fs.writeFileSync(path.join(dir, 'hive', 'a.jsonl'), 'two\n');
  assert.deepEqual(verifySnapshot(dir).diffs, ['changed hive/a.jsonl']);
  fs.rmSync(path.join(dir, 'hive', 'a.jsonl'));
  assert.deepEqual(verifySnapshot(dir).diffs, ['missing hive/a.jsonl']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('items: unique ids, an agent-id asker, at most 3 searches, each an argv list of strings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c90-items-'));
  const f = path.join(dir, 'items.jsonl');
  const bad = (rows, re) => { fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n')); assert.throws(() => parseItems(f), re); };
  fs.writeFileSync(f, `${JSON.stringify({ id: 'a', asker: 'creed-mukyiphw', searches: [['search', '--results', '3', 'x y']] })}\r\n\r\n`);
  assert.deepEqual(parseItems(f)[0].searches, [['search', '--results', '3', 'x y']], 'argv kept exactly as written');
  bad([{ id: 'a', asker: 'x', searches: [] }, { id: 'a', asker: 'x', searches: [] }], /repeated/);
  bad([{ id: 'a', asker: 'C:/Dunder/hive', searches: [] }], /bad asker/);
  bad([{ id: 'a', asker: 'x', searches: [['search', 'a'], ['search', 'b'], ['search', 'c'], ['search', 'd']] }], /at most 3/);
  bad([{ id: 'a', asker: 'x', searches: ['search q'] }], /argv list/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('arguments: snapshot, items and out are required; nothing unknown is accepted', () => {
  assert.throws(() => parseArgs(['--items', 'i', '--out', 'o']), /--snapshot is required/);
  assert.throws(() => parseArgs(['--snapshot', 's', '--items', 'i', '--out', 'o', '--live']), /unknown argument --live/);
});

test('PIN: the shim runs the tree\'s real memory CLI with the item\'s argv unchanged, as an agent shell would', () => {
  const child = codeOnly(readSource('test/claims-90/answer-child.cjs'));
  assert.match(child, /const cli = path\.join\(spec\.tree, 'resources', 'memory-cli\.cjs'\);/, 'the tree\'s own CLI');
  assert.match(child, /spawn\(process\.execPath, \[cli, \.\.\.argv\]/, 'argv passed through, nothing added or dropped');
  assert.match(child, /MUNDER_HIVE_ROOT: hive, MUNDER_MEMORY_URL: baseUrl, MEMORY_TOKEN: nativeMemory\.tokens\.mint\(asker\)/, 'the env main injects, pointing at the sandbox');
  assert.match(child, /nativeMemory\.handle\(m\[1\], body\)/, 'the route hands the body to main\'s own handler');
  assert.match(child, /nativeMemory\.setClaimWakeupProvider\(\(agentId\) => claimDelivery\.workingSet\(agentId\)\)/, 'wake-up gets main\'s claims append');
  assert.match(child, /claimDelivery\.workingSet\(item\.asker, s, WORKING_SET_MAX_CHARS\)/, 'the briefing entry\'s ceiling');
  assert.match(child, /onWorkerReady: \(\) => \{ workerReady = claimsIndex\.syncAll\(\); \}/, 'main\'s re-sync on worker start');
});

test('PIN: containment before product code, and no answer over a ledger that does not fully verify', () => {
  const child = codeOnly(readSource('test/claims-90/answer-child.cjs'));
  const jailAt = child.indexOf('const jail = jailProblem();');
  assert.ok(jailAt > 0 && jailAt < child.indexOf("L('src/main/claims/store.ts')"), 'the jail check runs before any tree module loads');
  assert.match(child, /LIVE_HIVE_RE\.test\(p\) \|\| !under\(p, spec\.home\)/, 'hive and user data must be inside the jailed home');
  assert.match(child, /const LEAK_RE = \/\^\(HIVE_\|AGENT_\|MEMORY_\|MUNDER_\|CLAUDE_CODE_\|CLAUDE\|CTH_\|KG_\)\/i;/);
  assert.match(child, /filter\(\(\[, v\]\) => v\.verified !== v\.records\)/, 'every ledger verifies to its full length');
  assert.match(child, /claims: \(\) => null,/, 'claim verbs (writes) are not wired for the answerer');
  const run = codeOnly(readSource('test/claims-90/run.cjs'));
  assert.match(run, /if \(links\.length\) throw/, 'a link or junction in the snapshot stops the run');
  assert.match(run, /if \(v\.diffs\.length\) throw/, 'a manifest difference stops the run');
  assert.match(run, /fs\.copyFileSync\(path\.join\(snap, f\.path\), dest\)/, 'the snapshot is copied, never used in place');
  const key = codeOnly(readSource('test/claims-90/key-unwrap.cjs'));
  assert.match(key, /new SafeStorageKeyProvider\(path\.join\(userData, MAC_KEY_FILE\), safeStorage\)\.load\(\)/, 'the product\'s own key provider');
  assert.doesNotMatch(key + run, /writeFileSync\([^)]*key\b/, 'the key is never written to a file');
});
