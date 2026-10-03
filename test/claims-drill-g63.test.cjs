'use strict';
/**
 * CLAIM-LEDGER W6, gate G6.3: the downgrade drill to 1.1.83 (spec amendment A7; plan §3 W6).
 *
 * W6 prepares a SANDBOX hive (never the live one), then Andy's Electron-as-Node runner (C4) runs
 * the 1.1.83 tree's OWN rollover, sources, engine, model and search over it (g63-downgrade.cjs).
 * Two scenarios, each with a fresh sandbox:
 *   - PLANNED: `memory export --complete` replaced each memory.md before the downgrade;
 *   - UNPLANNED: no export step; memory.md is still the small generated view, so the facts reach the
 *     old build only through the continuous `memory-ledger-export-*` files (and the archives).
 * Every checklist fact must be found by the old `memory search` (100%), including facts that exist
 * ONLY in the ledger (written after the migration); in the planned case the `## How I work` lessons
 * must survive the old rollover.
 *
 * THIS GATE FAILS, NEVER SKIPS (F7): no runner, no Electron, no model or no 1.1.83 tree is a failure.
 *
 * Data: an invented corpus by default (three agents; the largest is about 400 KB, like the largest
 * real agent). For the gate run on the bed snapshot, set CLAIMS_DRILL_SOURCE to a folder of agent
 * folders (e.g. the bed's snapshot/) and CLAIMS_DRILL_CHECKLIST to a JSON list of
 * {agent, query, expect}. Real memory text is read at run time only and never written to the repo.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const M = loadTs(path.join(ROOT, 'src', 'main', 'claims', 'migrate.ts'));
const E = loadTs(path.join(ROOT, 'src', 'main', 'claims', 'exportLedger.ts'));
const G = loadTs(path.join(ROOT, 'src', 'main', 'claims', 'generated.ts'));
const RUNNER = path.join(ROOT, 'test', 'claims-drill', 'runner.cjs');
const SCRIPT = path.join(ROOT, 'test', 'claims-drill', 'g63-downgrade.cjs');
const TREE_183 = process.env.CLAIMS_DRILL_TREE_183 || 'C:/Dunder/_work/drill-trees/v1.1.83';
const ABSENT = ['zq9absent4x1', 'zq9absent4x2'];

const LESSONS = ['- an invented standing lesson about checking the lock first', '- an invented standing lesson about base branches'];

/** An invented agent: archives plus memory.md, every fact with a unique searchable token. */
function inventAgent(dir, idx, targetBytes) {
  fs.mkdirSync(dir, { recursive: true });
  const tokens = [];
  let n = 0;
  const section = (day) => {
    const lines = [`## 2026-09-${String(day).padStart(2, '0')} invented session`];
    for (let k = 0; k < 6; k++, n++) {
      const t = `qf${idx}x${n}`;
      tokens.push(t);
      lines.push(`- 2026-09-${String(day).padStart(2, '0')} invented fact ${t}: the widget calibrates the gizmo ${'at length '.repeat(4)}`);
    }
    return lines.join('\n') + '\n\n';
  };
  let archive = '# Memory archive - invented\n\n';
  let day = 1;
  while (Buffer.byteLength(archive) < targetBytes * 0.8) archive += section(1 + (day++ % 28));
  fs.writeFileSync(path.join(dir, 'memory-archive-2026-09-20.md'), archive);
  let mem = `# Memory - invented agent ${idx}\n\n## How I work (standing lessons)\n${LESSONS.join('\n')}\n\n`;
  for (let s = 0; s < 4; s++) mem += section(1 + (day++ % 28));
  fs.writeFileSync(path.join(dir, 'memory.md'), mem);
  return tokens;
}

/** W6's side of a downgrade, for one agent: import, ledger-only claims, continuous export, then the scenario. */
function prepareAgent(agentDir, agent, scenario, postTokens) {
  const drafts = M.importLegacy(agentDir);
  for (const t of postTokens) drafts.push({ t: 'claim', kind: 'fact', text: `- 2026-10-04 a fact written after the migration ${t}`, source: 'self' });
  const records = drafts.map((d, i) => ({ v: 1, id: `${agent}-c${i}`, at: d.at || '2026-10-04T10:00:00.000Z', wt: '2026-10-04T10:00:00.000Z', agent, prev: '', mac: '', ...d }));
  const claims = {};
  for (const r of records) claims[r.id] = { id: r.id, status: 'live', sightings: 1, firstAt: r.at, lastAt: r.at, pinned: r.kind === 'lesson', reasons: [] };
  const state = { v: 1, agent, registryHash: '', ledgerHead: '', claims, conflicts: [] };
  E.syncExport(agentDir, records, state, E.standInExportLine);
  if (scenario === 'planned') {
    E.exportComplete(agentDir, state, { flags: {}, counters: {} }, E.standInCompleteMemory(records, agent));
  } else {
    // writer mode before an unplanned downgrade: memory.md is the small generated view
    fs.writeFileSync(path.join(agentDir, 'memory.md'), `${G.GENERATED_MEMORY_MARKER}\n# Memory - ${agent}\n\n## How I work (standing lessons)\n${LESSONS.join('\n')}\n`);
  }
  return records.length;
}

function sandbox(scenario) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `claims-g63-${scenario}-`));
  const hive = path.join(base, 'hive');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(hive, 'agents'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const checklist = [];
  const lessons = {};
  const src = process.env.CLAIMS_DRILL_SOURCE;
  if (src) {
    for (const a of fs.readdirSync(src)) {
      if (!fs.statSync(path.join(src, a)).isDirectory()) continue;
      fs.cpSync(path.join(src, a), path.join(hive, 'agents', a), { recursive: true });
      prepareAgent(path.join(hive, 'agents', a), a, scenario, []);
    }
    checklist.push(...JSON.parse(fs.readFileSync(process.env.CLAIMS_DRILL_CHECKLIST, 'utf8')));
  } else {
    [['ag-small', 40e3], ['ag-mid', 120e3], ['ag-large', 400e3]].forEach(([a, bytes], idx) => {
      const dir = path.join(hive, 'agents', a);
      const tokens = inventAgent(dir, idx, bytes);
      const post = [0, 1, 2, 3, 4].map((k) => `pm${idx}x${k}`);
      prepareAgent(dir, a, scenario, post);
      const step = Math.max(1, Math.floor(tokens.length / 12));
      for (let i = 0; i < tokens.length; i += step) checklist.push({ agent: a, query: tokens[i], expect: tokens[i] });
      for (const t of post) checklist.push({ agent: a, query: t, expect: t });
      lessons[a] = LESSONS;
    });
  }
  return { base, hive, home, checklist, lessons };
}

for (const scenario of ['planned', 'unplanned']) {
  test(`G6.3 ${scenario} downgrade to 1.1.83: the old build's own search finds 100% of the checklist`, async () => {
    assert.ok(fs.existsSync(RUNNER), `the Electron-as-Node runner is missing (${RUNNER}; W3/C4, Andy). This gate fails until it exists; it never skips.`);
    assert.ok(fs.existsSync(path.join(TREE_183, 'node_modules')), `the 1.1.83 tree is not ready: ${TREE_183}`);
    const { runDrill } = require(RUNNER);
    const s = sandbox(scenario);
    const result = await runDrill({ tree: TREE_183, hive: s.hive, home: s.home, script: SCRIPT, out: path.join(s.base, 'result.json'), args: { checklist: s.checklist, lessons: scenario === 'planned' ? s.lessons : {}, absent: ABSENT } });
    assert.equal(result.ok, true, `drill failed: ${result.reason || JSON.stringify(result).slice(0, 400)}`);
    assert.ok(result.total >= 30, `a real checklist (${result.total})`);
    assert.deepEqual(result.missing, [], `not found by 1.1.83's search: ${JSON.stringify(result.missing.slice(0, 5))}`);
    assert.equal(result.found, result.total);
    assert.deepEqual(result.absentFound, [], 'control: a token in no file is never counted as found');
    for (const [a, ok] of Object.entries(result.lessonsIntact)) assert.equal(ok, true, `How I work survived the old rollover for ${a}`);
    if (scenario === 'planned' && !process.env.CLAIMS_DRILL_SOURCE) assert.equal(result.rolled['ag-large'], true, 'the large complete export was rolled by 1.1.83');
  });
}

/** What 1.1.83 indexes for an agent: every direct *.md of its folder (sources.ts; non-recursive). */
const indexedText = (dir) => fs.readdirSync(dir).filter((n) => /\.md$/i.test(n)).map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).join('\n');

for (const scenario of ['planned', 'unplanned']) {
  test(`G6.3 ${scenario}, W6's side (no runner needed): every checklist fact is in a file 1.1.83 indexes, none of them over its 2 MiB cap`, () => {
    const s = sandbox(scenario);
    assert.ok(s.checklist.length >= 30);
    for (const a of fs.readdirSync(path.join(s.hive, 'agents'))) for (const t of ABSENT) assert.ok(!indexedText(path.join(s.hive, 'agents', a)).includes(t), `control token ${t} is in no file`);
    for (const item of s.checklist) {
      assert.ok(indexedText(path.join(s.hive, 'agents', item.agent)).includes(item.expect), `${item.agent}: ${item.expect}`);
    }
    for (const a of fs.readdirSync(path.join(s.hive, 'agents'))) {
      for (const f of fs.readdirSync(path.join(s.hive, 'agents', a)).filter((n) => /\.md$/i.test(n))) {
        assert.ok(fs.statSync(path.join(s.hive, 'agents', a, f)).size < E.OLD_BUILD_MAX_SOURCE_BYTES, `${a}/${f}`);
      }
      const mem = fs.readFileSync(path.join(s.hive, 'agents', a, 'memory.md'), 'utf8');
      assert.equal(G.isGeneratedMemory(mem), scenario === 'unplanned');
    }
  });
}
