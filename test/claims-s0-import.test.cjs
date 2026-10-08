'use strict';
/**
 * REL-184 S0 at claims start (Jim option (a), god 06:01Z): claims/startupImport.ts and its wiring.
 *   - the drill: a writer's legacy memory.md and archive notes are still found by search and in its
 *     wake-up after its FIRST claim (the control run without the import loses them);
 *   - importAtStart: every agent at shadow or higher, never an off one; a re-run appends nothing;
 *     a failure is logged, never thrown;
 *   - main: the import runs before anything forks the worker or appends a claim.
 * Invented text only. HOME and USERPROFILE are jailed before any product code loads.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-s0-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const loadTs = require('./load-ts.cjs');
const { runDrill } = require('./claims-drill/runner.cjs');
const TREE = path.join(__dirname, '..');
const { importAtStart } = loadTs('src/main/claims/startupImport.ts');
const { ClaimStore } = loadTs('src/main/claims/store.ts');
const { SandboxKeyProvider, FileLedgerKeyRecord, KEY_RECORD_FILE } = loadTs('src/main/claims/keyProvider.ts');
const { makeW6Append } = loadTs('src/main/claims/w6Append.ts');

let n = 0;
async function drill(args) {
  const dir = path.join(JAIL, `drill-${++n}`);
  const hive = path.join(dir, 'hive');
  fs.mkdirSync(hive, { recursive: true });
  const res = await runDrill({ tree: TREE, hive, home: path.join(dir, 'home'), script: path.join(__dirname, 'claims-s0', 'scenario.cjs'), needModel: false, args });
  assert.equal(res.ok, true, JSON.stringify(res, null, 2).slice(0, 3000));
  return res;
}

test('S0 at start: a writer\'s legacy notes are still found by search and wake-up after its first claim', { timeout: 5 * 60_000 }, async () => {
  const r = await drill({});
  assert.equal(r.firstOk, true);
  assert.deepEqual(r.imported, [{ agent: 'w1', appended: 2, refused: 0 }], 'the writer is imported, the off agent is not');
  assert.equal(r.importRows, 1, 'one claims-import row');
  assert.deepEqual(r.synced, [true]);
  assert.ok(r.segments > 0, 'the first claim made a segment, so discovery has swapped the markdown out');
  assert.match(r.zeppelin.top, /^legacy: [\s\S]*the zeppelin hangar code is twelve/, 'the memory.md note is the top hit, as an imported claim');
  assert.match(r.gizmo.top, /^legacy: [\s\S]*the gizmo relay uses crate seven/, 'the archive note is the top hit, as an imported claim');
  assert.match(r.widget.top, /the widget review moved to friday/, 'the new claim');
  assert.equal(r.zeppelin.markdown + r.gizmo.markdown, 0, 'the markdown itself is out of search');
  assert.deepEqual(r.wake, { zeppelin: true, gizmo: true, widget: true }, 'the wake-up carries both legacy notes and the new claim');

  // The control: the same run without the import is the gap Jim found.
  const c = await drill({ skipImport: true });
  assert.equal(c.firstOk, true);
  assert.doesNotMatch(String(c.zeppelin.top), /zeppelin/);
  assert.doesNotMatch(String(c.gizmo.top), /gizmo/);
  assert.equal(c.zeppelin.markdown + c.gizmo.markdown, 0);
  assert.deepEqual(c.wake, { zeppelin: false, gizmo: false, widget: true });
});

function sandbox() {
  const root = path.join(JAIL, `hive-${++n}`);
  for (const a of ['wr', 'sh', 'rd', 'of']) {
    fs.mkdirSync(path.join(root, 'agents', a), { recursive: true });
    fs.writeFileSync(path.join(root, 'agents', a, 'memory.md'), `# Memory\n\n## 2026-10-01\n- an invented note of ${a}\n`);
  }
  const rows = [];
  const store = new ClaimStore({ hiveRoot: root, keys: new SandboxKeyProvider(), keyRecord: new FileLedgerKeyRecord(path.join(`${root}-ud`, KEY_RECORD_FILE)), log: () => {} });
  const levels = { wr: 'writer', sh: 'shadow', rd: 'reader', of: 'off' };
  const deps = { hiveRoot: root, append: makeW6Append(store), read: (a) => store.readLedger(a), log: (r) => rows.push(r), agents: () => ['wr', 'sh', 'rd', 'of', 'wr'], level: (a) => levels[a] ?? 'off' };
  return { root, rows, store, deps };
}

test('importAtStart: every agent at shadow or higher once, never an off one; a re-run appends nothing', async () => {
  const x = sandbox();
  const first = await importAtStart(x.deps);
  assert.deepEqual(first.map((r) => [r.agent, r.appended]), [['wr', 1], ['sh', 1], ['rd', 1]]);
  assert.equal(x.store.segments('of').length, 0, 'an off agent gets no ledger');
  assert.ok(!fs.existsSync(path.join(x.root, 'backups', 'claims-frozen', 'of')), 'nor a frozen backup');
  for (const a of ['wr', 'sh', 'rd']) assert.ok(fs.existsSync(path.join(x.root, 'backups', 'claims-frozen', a, 'memory.md')), `${a} has its frozen backup`);
  assert.equal(x.rows.filter((r) => r.kind === 'claims-import').length, 3);
  const again = await importAtStart(x.deps);
  assert.deepEqual(again.map((r) => r.appended), [0, 0, 0], 'idempotent');
  x.store.close();
});

test('importAtStart never throws: a failing agent is logged and the rest still run', async () => {
  const x = sandbox();
  const out = await importAtStart({ ...x.deps, level: (a) => { if (a === 'sh') throw new Error('invented level failure'); return a === 'of' ? 'off' : 'writer'; } });
  assert.deepEqual(out.map((r) => r.agent), ['wr', 'rd']);
  assert.deepEqual(x.rows.filter((r) => r.kind === 'claims-import-failed').map((r) => r.agent), ['sh']);
  assert.deepEqual(await importAtStart({ ...x.deps, agents: () => { throw new Error('invented'); } }), []);
  x.store.close();
});

test('main runs the import before anything forks the memory worker or appends a claim', () => {
  const src = fs.readFileSync(path.join(TREE, 'src', 'main', 'index.ts'), 'utf8');
  const fn = src.slice(src.indexOf('function claimsImportReady('));
  assert.match(fn.slice(0, 1500), /importAtStart\(\{[\s\S]*append: makeW6Append\(ep\.store\)[\s\S]*level: claimLevel/, 'the import, with the level main uses');
  assert.match(src, /setMemoryHandler\(async \(token, body\) => \{ await claimsImportReady\(\); return nativeMemory\.handle\(token, body\); \}\)/, 'memory requests and claim verbs');
  assert.match(src, /send: \(args\) => claimsImportReady\(\)\.then\(\(\) => nativeMemory\.syncClaims\(args\)\)/, 'the index sync');
  assert.match(src, /void claimsImportReady\(\)\.then\(\(\) => \{ try \{ nativeMemory\.prewarm\(\);/, 'the prewarm');
  assert.match(src, /note: async \(args\) => \{\s*await claimsImportReady\(\);\s*const r = await handleClaimVerb\(/, 'the ledger route');
  assert.match(src, /'hive:searchMemory'[\s\S]{0,200}await claimsImportReady\(\);/, 'the Memory panel search');
  assert.match(src, /'hive:memoryWakeUp'[\s\S]{0,120}await claimsImportReady\(\);/, 'the Memory panel wake-up');
});
