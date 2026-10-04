'use strict';
/**
 * CLAIM-LEDGER W6 wiring (src/main/claims/exportWiring.ts + main's index.ts): the production callers
 * of the rollback exports.
 *   - the continuous export runs after every acked append of a WRITER agent, driven here through the
 *     real path: the `memory` CLI -> POST /memory/<token> (NativeMemoryWiring.handle) -> the claim
 *     verb -> ClaimStore.appendRecord -> its onAppend -> appendExport/syncExport + status markers;
 *   - the start-up sync (syncAll) catches up what was appended while nothing exported;
 *   - `memory export --complete` reaches exportComplete through the same CLI and endpoint;
 *   - main's index.ts calls all three (source pins: index.ts needs Electron to load).
 * HOME is jailed first; every text is invented.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-claims-export-wire-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
const STORES = [];
test.after(() => {
  for (const s of STORES) s.close();
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const ROOT = path.join(__dirname, '..');
const loadTs = require('./load-ts.cjs');
const { ClaimStore } = loadTs('src/main/claims/store.ts');
const { SandboxKeyProvider, FileLedgerKeyRecord, KEY_RECORD_FILE } = loadTs('src/main/claims/keyProvider.ts');
const { derive } = loadTs('src/main/claims/derive.ts');
const { worldView } = loadTs('src/main/claims/world.ts');
const { DEFAULT_KEY_REGISTRY } = loadTs('src/main/claims/registry.ts');
const { createClaimExport } = loadTs('src/main/claims/exportWiring.ts');
const E = loadTs('src/main/claims/exportLedger.ts');
const { importLegacy } = loadTs('src/main/claims/migrate.ts');
const { isGeneratedMemory } = loadTs('src/main/claims/generated.ts');
const { NativeMemoryWiring } = loadTs('src/main/nativeMemory/mainWiring.ts');
const cli = require(path.join(ROOT, 'resources', 'memory-cli.cjs'));

let n = 0;
/** A hive with the store's onAppend wired to the export, as main wires it, and the /memory endpoint. */
function setup({ level = () => 'writer', agentDir, defer, readOverride } = {}) {
  const root = path.join(JAIL, `hive-${++n}`);
  for (const a of ['a1', 'a2']) fs.mkdirSync(path.join(root, 'agents', a), { recursive: true });
  const logs = [];
  let store = null;
  const exp = createClaimExport({
    level,
    agentDir: agentDir ?? ((a) => path.join(root, 'agents', a)),
    readLedger: (a) => (readOverride ? readOverride(store.readLedger(a)) : store.readLedger(a)),
    registry: () => DEFAULT_KEY_REGISTRY,
    ...(defer ? { defer } : {}),
    derive,
    view: (_a, records, state) => worldView(state, records, [], { now: new Date().toISOString(), taskStatus: () => null, fileExists: () => true, commitExists: () => true, fileChangedSince: () => false, cardOutcomes: {} }),
    log: (row) => logs.push(row),
  });
  let wired = true;
  store = new ClaimStore({ hiveRoot: root, keys: new SandboxKeyProvider(), keyRecord: new FileLedgerKeyRecord(path.join(`${root}-ud`, KEY_RECORD_FILE)), log: (r) => logs.push(r), onAppend: (a, id, rec) => { if (wired) exp.onAppend(a, id, rec); } });
  STORES.push(store);
  const w = new NativeMemoryWiring({
    hiveRoot: () => root, enabled: () => true, userData: JAIL, resourcesDir: path.join(JAIL, 'none'), workerEntry: 'none',
    fork: () => { throw new Error('the claim verbs never fork the worker'); },
    memoryBaseUrl: () => null, writeCommand: () => null, log: () => undefined, vecLoadablePath: () => null,
    claims: () => ({ store, level, exportComplete: (a) => exp.complete(a) }),
  });
  const dir = (a = 'a1') => path.join(root, 'agents', a);
  const exportText = (a = 'a1') => E.exportFiles(dir(a)).map((f) => fs.readFileSync(path.join(dir(a), f), 'utf8')).join('');
  return { root, store, exp, w, logs, dir, exportText, unwire: () => { wired = false; }, rewire: () => { wired = true; } };
}

/** Run the real `memory` CLI against a loopback server that hands the body to the endpoint. */
async function memory(x, agent, argv) {
  const token = x.w.tokens.mint(agent);
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', async () => {
      const r = await x.w.handle(req.url.split('/').pop(), JSON.parse(Buffer.concat(chunks).toString()));
      res.statusCode = r.status; res.end(JSON.stringify(r.body));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const out = [], err = [];
  try {
    const code = await cli.main(argv, { MUNDER_MEMORY_URL: `http://127.0.0.1:${srv.address().port}/memory`, MEMORY_TOKEN: token }, { out: (s) => out.push(s), err: (s) => err.push(s) });
    return { code, out: out.join(''), err: err.join('') };
  } finally { srv.close(); }
}
const idOf = (r) => /(c-[0-9a-f]+)/.exec(r.out)?.[1];

test('continuous export: a note through the real CLI and endpoint is exported after the ack, one tagged line per record', async () => {
  const x = setup();
  const a = await memory(x, 'a1', ['note', 'synthetic relay listens on port 4471']);
  const b = await memory(x, 'a1', ['note', '--kind', 'decision', 'synthetic window moves to friday']);
  assert.equal(a.code, 0, a.err); assert.equal(b.code, 0, b.err);
  await x.exp.drain();
  const ids = E.exportedIds(x.dir());
  assert.deepEqual([...ids].sort(), [idOf(a), idOf(b)].sort());
  assert.match(x.exportText(), /^# Memory ledger export - a1 - \d{4}-\d{2}\n/);
  assert.ok(x.logs.some((r) => r.kind === 'claims-export-append' && r.id === idOf(b) && r.lines === 1));
  for (const f of E.exportFiles(x.dir())) assert.match(f, E.EXPORT_RE);
});

test('continuous export: a retraction appends the retracting claim AND a status marker line (never an edit)', async () => {
  const x = setup();
  const a = idOf(await memory(x, 'a1', ['note', 'synthetic cache is cold']));
  await x.exp.drain();
  const before = x.exportText();
  const r = await memory(x, 'a1', ['retract', a, '--why', 'synthetic cache warmed']);
  assert.equal(r.code, 0, r.err);
  await x.exp.drain();
  const after = x.exportText();
  assert.ok(after.startsWith(before), 'append-only: the earlier text is untouched');
  assert.match(after, new RegExp(`status of \\[c:${a}\\]: live -> retracted`));
  assert.equal(E.exportedIds(x.dir()).size, 2, 'the target line and the retracting claim; the marker exports nothing');
});

test('continuous export: only WRITER agents are exported (the effective level is checked per append)', async () => {
  const x = setup({ level: (a) => (a === 'a1' ? 'writer' : 'reader') });
  await x.store.appendRecord('a2', { t: 'claim', kind: 'fact', text: 'synthetic reader fact' }, 'endpoint');
  await x.store.appendRecord('a1', { t: 'claim', kind: 'fact', text: 'synthetic writer fact' }, 'endpoint');
  await x.exp.drain();
  assert.deepEqual(E.exportFiles(x.dir('a2')), [], 'a reader agent gets no export file');
  assert.equal(E.exportedIds(x.dir('a1')).size, 1);
});

test('catch-up: records appended while nothing exported come out with the next append, and syncAll is the start-up path (idempotent)', async () => {
  const x = setup();
  x.unwire();
  const missed = await x.store.appendRecord('a1', { t: 'claim', kind: 'fact', text: 'synthetic missed fact' }, 'endpoint');
  await x.store.appendRecord('a2', { t: 'claim', kind: 'fact', text: 'synthetic a2 missed fact' }, 'endpoint');
  x.rewire();
  const next = await x.store.appendRecord('a1', { t: 'claim', kind: 'fact', text: 'synthetic next fact' }, 'endpoint');
  await x.exp.drain();
  assert.deepEqual([...E.exportedIds(x.dir())].sort(), [missed.id, next.id].sort(), 'a crash gap is caught up by the next append');
  assert.equal(x.exp.syncAll(['a1', 'a2', 'nobody']), 1, 'start-up: a2\'s one record');
  assert.equal(E.exportedIds(x.dir('a2')).size, 1);
  assert.equal(x.exp.syncAll(['a1', 'a2']), 0, 'idempotent');
});

test('a failing export never reaches the append: the claim is acked and the failure is a log row', async () => {
  const x = setup({ agentDir: () => { throw new Error('synthetic folder failure'); } });
  const r = await x.store.appendRecord('a1', { t: 'claim', kind: 'fact', text: 'synthetic acked fact' }, 'endpoint');
  assert.equal(r.ok, true);
  await x.exp.drain();
  assert.ok(x.logs.some((l) => l.kind === 'claims-export-failed' && l.step === 'append' && /synthetic folder failure/.test(l.error)), JSON.stringify(x.logs));
  assert.equal(x.store.readLedger('a1').records.length, 1);
});

test('export --complete through the real CLI and endpoint: memory.md becomes the complete rendering, with no generated marker', async () => {
  const x = setup();
  const lesson = idOf(await memory(x, 'a1', ['note', '--kind', 'lesson', 'synthetic lesson: run the tests first']));
  const fact = idOf(await memory(x, 'a1', ['note', 'synthetic fact for the complete export']));
  fs.writeFileSync(path.join(x.dir(), 'memory.md'), '# Memory - a1\n\n- synthetic old body\n');
  const r = await memory(x, 'a1', ['export', '--complete']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^exported a complete memory\.md \(\d+ bytes\)\n/);
  assert.ok(r.out.includes(E.COMPLETE_EXPORT_NOTE));
  const md = fs.readFileSync(path.join(x.dir(), 'memory.md'), 'utf8');
  assert.equal(isGeneratedMemory(md), false, 'an older build must roll it over like any memory.md');
  assert.match(md, /## How I work/);
  assert.ok(md.includes(`[c:${lesson}]`) && md.includes(`[c:${fact}]`));
  assert.ok(!md.includes('synthetic old body'));
  assert.ok(x.logs.some((l) => l.kind === 'claims-export-complete' && l.agentId === 'a1'));
});

test('export --complete leaves out the entries an archive in the folder still holds (ruling 2), and keeps the rest', async () => {
  const x = setup();
  const d = x.dir();
  fs.writeFileSync(path.join(d, 'memory-archive-2026-09-20.md'), '# Memory archive - a1\n\n## 2026-09-01 synthetic\n- 2026-09-01 synthetic archived fact alpha\n- 2026-09-02 synthetic archived fact beta\n');
  fs.writeFileSync(path.join(d, 'memory.md'), '# Memory - a1\n\n## 2026-10-01 synthetic\n- 2026-10-01 synthetic live fact gamma\n');
  x.unwire();
  for (const draft of importLegacy(d)) assert.equal((await x.store.appendRecord('a1', draft, 'w6-internal')).ok, true);
  x.rewire();
  const r = await memory(x, 'a1', ['export', '--complete']);
  assert.equal(r.code, 0, r.err);
  const md = fs.readFileSync(path.join(d, 'memory.md'), 'utf8');
  assert.ok(md.includes('synthetic live fact gamma'));
  assert.ok(!md.includes('synthetic archived fact alpha') && !md.includes('synthetic archived fact beta'), 'the archive already holds them');
});

test('export --complete: refused below writer, without --complete, and when this build has no export wired', async () => {
  const x = setup({ level: () => 'reader' });
  const r = await memory(x, 'a1', ['export', '--complete']);
  assert.equal(r.code, 3);
  const y = setup();
  const bare = await memory(y, 'a1', ['export']);
  assert.equal(bare.code, 2);
  assert.match(bare.err, /export needs --complete/);
  const { handleClaimVerb } = loadTs('src/main/claims/endpoint.ts');
  const none = await handleClaimVerb({ store: y.store, level: () => 'writer' }, 'a1', { cmd: 'export', args: { complete: true } }, 'endpoint');
  assert.equal(none.exit, 3);
  assert.match(none.error, /not available/);
  assert.deepEqual(cli.parseArgs(['export', '--complete']).args, { complete: true });
});

// ——— Creed M-A: only W3's verifiedPrefix is ever exported ———

/** Four claims, then the second one's text edited in its segment (a MAC break at that record). */
async function tampered(x) {
  const ids = [];
  x.unwire();
  for (let i = 0; i < 4; i++) ids.push((await x.store.appendRecord('a1', { t: 'claim', kind: 'fact', text: `synthetic orchard line ${i}` }, 'endpoint')).id);
  x.rewire();
  const seg = x.store.segments('a1')[0];
  fs.writeFileSync(seg, fs.readFileSync(seg, 'utf8').replace('synthetic orchard line 1', 'synthetic orchard line X'));
  const read = x.store.readLedger('a1');
  assert.notEqual(read.chain, 'ok', 'the edit breaks the chain');
  return { ids, read };
}

test('M-A truncated: past a MAC break nothing is exported on the append and sync paths, and complete refuses (ids logged, no text)', async () => {
  const x = setup();
  const { ids, read } = await tampered(x);
  const brokenAt = read.chain.brokenAt;
  // The append path: the store refuses appends on a broken ledger, so its onAppend is driven as the store would.
  x.exp.onAppend('a1', ids[3], read.records.find((r) => r.id === ids[3]));
  await x.exp.drain();
  const before = ids.slice(0, ids.indexOf(brokenAt));
  assert.ok(before.length >= 1);
  assert.deepEqual([...E.exportedIds(x.dir())].sort(), [...before].sort(), 'only the records before the break');
  assert.ok(!x.exportText().includes('synthetic orchard line X'), 'never the tampered text');
  assert.equal(x.exp.syncAll(['a1']), 0, 'the sync path adds nothing past the break');
  assert.deepEqual([...E.exportedIds(x.dir())].sort(), [...before].sort());
  for (const step of ['append', 'sync']) assert.ok(x.logs.some((l) => l.kind === 'claims-export-truncated' && l.step === step && l.truncatedAt === brokenAt), step);
  fs.writeFileSync(path.join(x.dir(), 'memory.md'), '# Memory - a1\n\n- synthetic untouched body\n');
  const r = await memory(x, 'a1', ['export', '--complete']);
  assert.equal(r.code, 3);
  assert.match(r.err, new RegExp(`fails verification at ${brokenAt}`));
  assert.equal(fs.readFileSync(path.join(x.dir(), 'memory.md'), 'utf8'), '# Memory - a1\n\n- synthetic untouched body\n', 'memory.md is not changed');
  assert.ok(x.logs.some((l) => l.kind === 'claims-export-truncated' && l.step === 'complete'));
  assert.ok(!JSON.stringify(x.logs.filter((l) => /^claims-export-/.test(l.kind))).includes('synthetic orchard'), 'log rows carry no text');
});

test('M-A unverified (a lost key or a cut ledger): nothing at all is exported on any path, and it is logged', async () => {
  const lost = (r) => ({ ...r, chain: { reason: 'key-missing', brokenAt: r.records[0]?.id ?? '' } });
  const x = setup({ readOverride: lost });
  const a = await x.store.appendRecord('a1', { t: 'claim', kind: 'fact', text: 'synthetic unverifiable fact' }, 'endpoint');
  assert.equal(a.ok, true);
  await x.exp.drain();
  assert.equal(x.exp.syncAll(['a1']), 0);
  assert.deepEqual(E.exportFiles(x.dir()), [], 'no export file on the append or sync path');
  fs.writeFileSync(path.join(x.dir(), 'memory.md'), '# Memory - a1\n');
  const c = x.exp.complete('a1');
  assert.equal(c.ok, false);
  assert.match(c.error, /cannot be verified/);
  assert.equal(fs.readFileSync(path.join(x.dir(), 'memory.md'), 'utf8'), '# Memory - a1\n');
  for (const step of ['append', 'sync', 'complete']) assert.ok(x.logs.some((l) => l.kind === 'claims-export-unverified' && l.step === step && l.reason === 'key-missing'), step);
  const y = setup({ readOverride: (r) => ({ ...r, chain: { reason: 'mac', brokenAt: 'head-anchor' } }) });
  await y.store.appendRecord('a1', { t: 'claim', kind: 'fact', text: 'synthetic cut-ledger fact' }, 'endpoint');
  await y.exp.drain();
  assert.deepEqual(E.exportFiles(y.dir()), [], 'a ledger cut below its anchored head exports nothing');
});

// ——— Creed M-B: markers from positional states ———

test('M-B a no-yield burst: the export work runs after the whole burst, and each real status change is marked exactly once', async () => {
  const held = [];
  const x = setup({ defer: (fn) => { held.push(fn); } });
  const a = (await x.store.appendRecord('a1', { t: 'claim', kind: 'fact', text: 'synthetic burst fact' }, 'endpoint')).id;
  const b = (await x.store.appendRecord('a1', { t: 'claim', kind: 'fact', text: 'synthetic burst replacement', supersedes: [a] }, 'endpoint')).id;
  const c = (await x.store.appendRecord('a1', { t: 'claim', kind: 'fact', text: 'synthetic burst bystander' }, 'endpoint')).id;
  const r = (await x.store.appendRecord('a1', { t: 'claim', kind: 'fact', text: 'synthetic burst withdrawal', retracts: [c] }, 'endpoint')).id;
  // A later record changes an EARLIER claim's status: a non-positional "before" would see it early.
  const dd = (await x.store.appendRecord('a1', { t: 'claim', kind: 'fact', text: 'synthetic burst second replacement', supersedes: [b] }, 'endpoint')).id;
  // Every job runs only now, against the whole ledger (the burst had no yield to the queue).
  while (held.length) { held.shift()(); await new Promise((res) => setImmediate(res)); }
  await x.exp.drain();
  const markers = x.exportText().split('\n').filter((l) => l.includes(' status of [c:'));
  assert.deepEqual(markers.map((l) => l.replace(/^- \S+ /, '')).sort(), [`status of [c:${a}]: live -> superseded`, `status of [c:${c}]: live -> retracted`, `status of [c:${b}]: live -> superseded`].sort(), markers.join('\n'));
  assert.equal(E.exportedIds(x.dir()).size, 5, [a, b, c, r, dd].join(','));
  const at = (id) => x.store.readLedger('a1').records.find((rec) => rec.id === id).wt;
  assert.ok(markers.some((l) => l.startsWith(`- ${at(b)} status of [c:${a}]`)), 'a marker carries the time of the record that caused it');
});

test('main wires all three callers (index.ts loads only under Electron, so its wiring is pinned by source)', () => {
  const idx = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(idx, /onAppend: \(agentId, id, rec\) => \{\n\s+claimExport\(\)\.onAppend\(agentId, id, rec\);\n\s+if \(!shouldRunR5\(rec\)\)/, 'every acked append, before the R5 branch returns');
  assert.match(idx, /return \{ store: claimStore\.store, level: claimLevel, exportComplete: \(agentId\) => claimExport\(\)\.complete\(agentId\), onReconcile:/, 'memory export --complete and W5 reconcile answer callback');
  assert.match(idx, /setImmediate\(\(\) => \{ try \{ claimExport\(\)\.syncAll\(claimLedgerAgents\(\)\); \}/, 'the start-up catch-up');
  assert.match(idx, /createClaimExport\(\{[\s\S]{0,400}level: claimLevel,[\s\S]{0,200}readLedger: \(agentId\) => \(claimsEndpoint\(\) as ClaimsEndpointDeps\)\.store\.readLedger\(agentId\)/, 'the verified ledger, at the effective level');
});
