'use strict';
require('./tools/own-job.cjs');
/**
 * CLAIMS-DEFAULT (god bb3f5b): a NEW floor starts on the claim ledger, an existing one is unchanged.
 * C1 memory-sources.json `ledgerDefault` stands in for an absent agent entry; C2 a hive created now is
 * seeded with ledgerDefault writer; C3 a fresh config (no file, or a reset) has claimLedger writer, an
 * existing file without the key stays off; C4 the seed names the project folder as `derivedRepo` when it
 * is a git repo, and the floor's repo overrides config; C5 the Settings summary shows both.
 * Census: test/tools/claims-ledger-default-mutants.cjs. Synthetic ids only.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** TEST-TEMP-HYGIENE: every temp entry this file makes, removed once at the end (the runner fails a leak). */
const made = [];
const tmp = (tag) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `claims-ledger-default-${tag}-`)); made.push(d); return d; };
test.after(() => { for (const d of made.reverse()) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
const userData = tmp('cfg');
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => userData } } };

const loadTs = require('./load-ts.cjs');
const { manifestEntry, effectiveLevel, DERIVED_AGENT_ID } = loadTs('src/shared/claims.ts');
const { readSourcesConfig, discoverSources, SOURCES_CONFIG_FILE } = loadTs('src/main/nativeMemory/sources.ts');
const { newFloorSources, seedFloorSources, derivedRepoFor } = loadTs('src/main/claims/floorSeed.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { createLedgerUi } = loadTs('src/main/claims/ledgerUi.ts');
const cfg = loadTs('src/main/config.ts');

/** The level main (claimLevel) and the worker (discoverSources) both compute for an agent. */
const levelOf = (root, agentId, saved = 'writer') => {
  const f = readSourcesConfig(root);
  return effectiveLevel(saved, manifestEntry(f.ledger, agentId, f.ledgerDefault)).level;
};
const newHive = (project) => {
  const home = tmp('home');
  const hive = new HiveManager(() => home);
  hive.setNewHiveSeed((root) => { seedFloorSources(root, project); });
  hive.ensureHive();
  return { hive, root: hive.root() };
};

test('(a) a new hive is seeded with ledgerDefault writer: a hired agent is writer, in main and in discovery', () => {
  const { root } = newHive(null);
  const f = readSourcesConfig(root);
  assert.equal(f.ledgerDefault, 'writer');
  fs.mkdirSync(path.join(root, 'agents', 'syn-agent-1'), { recursive: true });
  assert.equal(levelOf(root, 'syn-agent-1'), 'writer');
  const d = discoverSources(root, readSourcesConfig(root), { claimLedger: 'writer' });
  assert.equal(d.ledgerLevels['syn-agent-1'], 'writer', 'the worker discovery agrees');
});

test('(b) an unlisted agent takes ledgerDefault', () => {
  assert.equal(manifestEntry({}, 'syn-agent-2', 'writer'), 'writer');
  assert.equal(manifestEntry(undefined, 'syn-agent-2', 'reader'), 'reader');
});

test('(c) a manifest without ledgerDefault keeps REL-184: an unlisted agent stays off', () => {
  const root = tmp('old');
  fs.writeFileSync(path.join(root, SOURCES_CONFIG_FILE), JSON.stringify({ topLevel: [], include: {}, ledger: { 'syn-agent-3': 'writer' } }));
  assert.equal(levelOf(root, 'syn-agent-3'), 'writer');
  assert.equal(levelOf(root, 'syn-agent-4'), 'off');
  assert.equal(manifestEntry({}, 'syn-agent-4'), undefined);
  assert.equal(manifestEntry({}, DERIVED_AGENT_ID), 'writer', 'the derived ledger still defaults to writer');
});

test('(d) an explicit entry beats ledgerDefault', () => {
  assert.equal(manifestEntry({ 'syn-agent-5': 'off' }, 'syn-agent-5', 'writer'), 'off');
  assert.equal(effectiveLevel('writer', manifestEntry({ 'syn-agent-5': 'off' }, 'syn-agent-5', 'writer')).level, 'off');
});

test('(e) the global level still caps ledgerDefault', () => {
  assert.equal(effectiveLevel('off', manifestEntry({}, 'syn-agent-6', 'writer')).level, 'off');
  assert.equal(effectiveLevel('reader', manifestEntry({}, 'syn-agent-6', 'writer')).level, 'reader');
});

test('(f) a fresh config has claimLedger writer; an existing file without the key stays off', () => {
  const file = path.join(userData, 'config.json');
  fs.rmSync(file, { force: true });
  assert.equal(cfg.readConfig().claimLedger, 'writer', 'no file: the fresh-install shape');
  assert.equal(cfg.resetConfig().claimLedger, 'writer', 'a reset is a fresh install');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).claimLedger, 'writer', 'and it is written');
  const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete existing.claimLedger;
  fs.writeFileSync(file, JSON.stringify(existing));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal(cfg.readConfig().claimLedger, undefined, 'an existing file without the key: absent = off');
});

test('(g) an existing hive is never re-seeded: ensureHive again, or a hand-written manifest, stays as it is', () => {
  const { hive, root } = newHive(null);
  const file = path.join(root, SOURCES_CONFIG_FILE);
  fs.writeFileSync(file, JSON.stringify({ topLevel: [], include: {}, ledger: { 'syn-agent-7': 'reader' } }));
  hive.ensureHive();
  assert.equal(readSourcesConfig(root).ledgerDefault, undefined, 'the second bootstrap seeds nothing');
  assert.equal(seedFloorSources(root, null), false, 'a file that exists is never overwritten');
  // A hive folder with no registry.json but a manifest already: the manifest is kept.
  const home = tmp('pre');
  fs.mkdirSync(path.join(home, 'hive'), { recursive: true });
  fs.writeFileSync(path.join(home, 'hive', SOURCES_CONFIG_FILE), JSON.stringify({ topLevel: [], include: {}, ledger: {} }));
  const h2 = new HiveManager(() => home);
  h2.setNewHiveSeed((r) => { seedFloorSources(r, null); });
  h2.ensureHive();
  assert.equal(readSourcesConfig(h2.root()).ledgerDefault, undefined);
});

test('(h) main and the worker discovery give one level for the same inputs', () => {
  const root = tmp('agree');
  fs.writeFileSync(path.join(root, SOURCES_CONFIG_FILE), JSON.stringify({ topLevel: [], include: {}, ledger: { 'syn-a': 'off', 'syn-b': 'reader' }, ledgerDefault: 'writer' }));
  for (const id of ['syn-a', 'syn-b', 'syn-c']) fs.mkdirSync(path.join(root, 'agents', id), { recursive: true });
  const d = discoverSources(root, readSourcesConfig(root), { claimLedger: 'writer' });
  for (const id of ['syn-a', 'syn-b', 'syn-c']) assert.equal(d.ledgerLevels[id] ?? 'off', levelOf(root, id), id);
  assert.deepEqual([d.ledgerLevels['syn-a'], d.ledgerLevels['syn-b'], d.ledgerLevels['syn-c']], [undefined, 'reader', 'writer']);
});

test('EQ (Jim e7aa07 a): with no ledgerDefault and no derivedRepo, manifestEntry, discovery, claimLevel and repo() equal 3aaf0d12', () => {
  // The 3aaf0d12 definitions, verbatim in behaviour.
  const oldEntry = (ledger, id) => { const v = ledger?.[id]; return v === undefined && id === DERIVED_AGENT_ID ? 'writer' : v; };
  const oldRepo = (r) => (typeof r === 'string' && r.trim() ? r : null);
  const root = tmp('eq');
  const ledger = { 'syn-w': 'writer', 'syn-r': 'reader', 'syn-o': 'off', 'syn-g': 'Writer' };
  fs.writeFileSync(path.join(root, SOURCES_CONFIG_FILE), JSON.stringify({ topLevel: [], include: {}, ledger }));
  const ids = ['syn-w', 'syn-r', 'syn-o', 'syn-g', 'syn-absent', DERIVED_AGENT_ID];
  // Each agent has markdown, a settled import and a ledger segment, so its level decides its source set.
  for (const id of ids) {
    fs.mkdirSync(path.join(root, 'agents', id, 'memory', 'claims'), { recursive: true });
    fs.writeFileSync(path.join(root, 'agents', id, 'memory.md'), '# m\n');
    fs.writeFileSync(path.join(root, 'agents', id, 'memory', 'claims-import.json'), '{}');
    fs.writeFileSync(path.join(root, 'agents', id, 'memory', 'claims', '2026-10.jsonl'), '');
  }
  const f = readSourcesConfig(root);
  assert.equal(f.ledgerDefault, undefined); assert.equal(f.derivedRepo, undefined);
  for (const saved of ['writer', 'reader', 'off', undefined]) {
    for (const id of ids) {
      assert.equal(manifestEntry(f.ledger, id, f.ledgerDefault), oldEntry(ledger, id), `manifestEntry ${id}`);
      // claimLevel (index.ts): effectiveLevel(saved, manifestEntry(floor.ledger, agentId, floor.ledgerDefault)).
      assert.deepEqual(effectiveLevel(saved, manifestEntry(f.ledger, id, f.ledgerDefault)), effectiveLevel(saved, oldEntry(ledger, id)), `claimLevel ${saved} ${id}`);
    }
    const now = discoverSources(root, f, { claimLedger: saved });
    const was = discoverSources(root, { topLevel: [], include: {}, ledger }, { claimLedger: saved });
    assert.deepEqual(now.ledgerLevels, was.ledgerLevels, `discovery levels ${saved}`);
    assert.deepEqual(now.eligible.map((e) => e.path), was.eligible.map((e) => e.path), `discovery source set ${saved}`);
  }
  // repo() (index.ts): derivedRepoFor(floor derivedRepo, config derivedClaimsRepo).
  for (const c of ['C:/syn/repo', '', '  ', undefined, null, 7]) assert.equal(derivedRepoFor(f.derivedRepo, c), oldRepo(c), `repo() with config ${JSON.stringify(c)}`);
});

test('C4: the seed names the project folder as derivedRepo only when it is a git repo; the floor repo overrides config', () => {
  const repo = tmp('repo');
  fs.mkdirSync(path.join(repo, '.git'));
  const plain = tmp('plain');
  assert.equal(newFloorSources(repo).derivedRepo, repo);
  assert.equal(newFloorSources(plain).derivedRepo, undefined, 'not a git repo: unset');
  assert.equal(newFloorSources(null).derivedRepo, undefined, 'no project folder: unset');
  assert.equal(newFloorSources('relative/dir', () => true).derivedRepo, undefined, 'a relative path is never a repo');
  const { root } = newHive(repo);
  assert.equal(readSourcesConfig(root).derivedRepo, repo, 'a new hive over a git project reads it');
  assert.equal(derivedRepoFor(repo, 'C:/other'), repo, 'the floor repo wins');
  assert.equal(derivedRepoFor(undefined, 'C:/other'), 'C:/other', 'else the config repo');
  assert.equal(derivedRepoFor(undefined, '  '), null, 'else none');
});

test('main wiring: claimLevel reads the floor default, the derived writer reads the floor repo, a new hive is seeded', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(src.includes('manifestEntry(floor.ledger, agentId, floor.ledgerDefault)'), 'claimLevel passes ledgerDefault');
  assert.ok(src.includes("repo: () => { const root = hive.root(); return derivedRepoFor(root ? readSourcesConfig(root).derivedRepo : undefined, readConfig().derivedClaimsRepo); }"), 'the derived writer reads the floor repo first');
  assert.ok(/hive\.setNewHiveSeed\(\(root\) => \{\n  const project = readConfig\(\)\.registeredRepos\?\.\[0\] \?\? null;\n  const wrote = seedFloorSources\(root, project\);/.test(src), 'a new hive is seeded from the first registered repo');
});

test('C5: the Settings summary shows the floor default and the derived repo (or that none is set)', () => {
  const ui = (floor) => createLedgerUi({ store: () => null, agents: () => [], level: () => 'off', savedLevel: () => 'writer', saveLevel: () => {}, levelChanged: () => null, registry: () => ({}), derive: () => ({}), verifiedPrefix: () => null, exportComplete: () => ({ ok: false, error: '' }), scrubExport: () => 0, confirm: async () => false, log: () => {}, floor });
  assert.deepEqual(ui(() => ({ ledgerDefault: 'writer', derivedRepo: 'C:/p' })).summary().floor, { ledgerDefault: 'writer', derivedRepo: 'C:/p' });
  assert.deepEqual(ui(() => ({ ledgerDefault: undefined, derivedRepo: null })).summary().floor, { ledgerDefault: null, derivedRepo: null });
  assert.deepEqual(ui(() => ({ ledgerDefault: 'Writer', derivedRepo: null })).summary().floor.ledgerDefault, null, 'a garbled default shows as none');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'components', 'ClaimLedgerSettings.tsx'), 'utf8');
  assert.match(src, /No git repo is set for derived facts/);
  assert.match(src, /an agent without its own entry is off/);
});
