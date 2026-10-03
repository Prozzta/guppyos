'use strict';
/**
 * CLAIM-LEDGER G3.2 latency gate (frozen: the full-corpus default-search p95 <= 1.5x today's).
 * An EXPLICIT gate run, not part of the default suite (two full-corpus embeds with the real model):
 *   node --test test/claims-gates/g32.test.cjs        (under the heavy lock)
 * The corpus is a READ-ONLY copy of the live hive's indexable Markdown (CLAIMS_G32_SOURCE, default
 * C:\Dunder\hive) into a sandbox; nothing in the live hive is written. "Today" is 1.1.83's engine
 * (_work/drill-trees/v1.1.83); "new" is this tree with every agent at reader and its memory.md
 * bullets as claims. Same queries (deterministic, from the corpus), same model, warm, k = 5.
 * It fails, never skips, when a tree, Electron or the model is missing. Writes the numbers to
 * CLAIMS_G32_REPORT (default <sandbox>/g32.json).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SOURCE = process.env.CLAIMS_G32_SOURCE || 'C:\\Dunder\\hive';
const OLD = process.env.CLAIMS_DRILL_TREE_183 || 'C:\\Dunder\\_work\\drill-trees\\v1.1.83';
const NEW = path.join(__dirname, '..', '..');
const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-g32-'));
test.after(() => fs.rmSync(JAIL, { recursive: true, force: true }));
const { runDrill } = require('../claims-drill/runner.cjs');

const MAX = 2 * 1024 * 1024;
/** Copy the indexable Markdown only: agents/<id>/*.md (direct, <= 2 MiB). Read-only on the source. */
function copyCorpus(dst) {
  const agents = fs.readdirSync(path.join(SOURCE, 'agents'), { withFileTypes: true }).filter((d) => d.isDirectory() && /^[A-Za-z0-9._-]+$/.test(d.name)).map((d) => d.name);
  let files = 0, bytes = 0;
  for (const a of agents) {
    let ents = [];
    try { ents = fs.readdirSync(path.join(SOURCE, 'agents', a), { withFileTypes: true }); } catch { continue; }
    for (const f of ents) {
      if (!f.isFile() || !/\.md$/i.test(f.name)) continue;
      const src = path.join(SOURCE, 'agents', a, f.name);
      const st = fs.statSync(src);
      if (st.size > MAX) continue;
      fs.mkdirSync(path.join(dst, 'agents', a), { recursive: true });
      fs.copyFileSync(src, path.join(dst, 'agents', a, f.name));
      files++; bytes += st.size;
    }
  }
  return { agents, files, bytes };
}

/** memory.md (and archives) bullets per agent: what the S0 import makes claims of. */
function bulletsOf(hive, agents) {
  const out = {};
  for (const a of agents) {
    const dir = path.join(hive, 'agents', a);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^memory(-archive-.*)?\.md$/i.test(n)) : [];
    out[a] = files.flatMap((n) => fs.readFileSync(path.join(dir, n), 'utf8').split(/\r?\n/).filter((l) => /^\s*[-*]\s+\S/.test(l)).map((l) => l.replace(/^\s*[-*]\s+/, '').slice(0, 4000)));
  }
  return out;
}

function queriesFrom(bullets, n = 200) {
  const all = Object.values(bullets).flat().filter((b) => b.split(/\s+/).length >= 4);
  const out = [];
  for (let i = 0; i < n && all.length; i++) {
    const words = all[(i * 7919) % all.length].split(/\s+/).filter((w) => /^[A-Za-z][\w-]{2,}$/.test(w));
    if (words.length >= 2) out.push(words.slice(i % Math.max(1, words.length - 3), (i % Math.max(1, words.length - 3)) + 3).join(' '));
  }
  return out;
}

test('G3.2: the full-corpus default-search p95 of the new build is at most 1.5x 1.1.83', { timeout: 60 * 60_000 }, async () => {
  const oldHive = path.join(JAIL, 'old-hive');
  const newHive = path.join(JAIL, 'new-hive');
  const corpus = copyCorpus(oldHive);
  copyCorpus(newHive);
  assert.ok(corpus.files > 10, `a real corpus (${corpus.files} files)`);
  const bullets = bulletsOf(newHive, corpus.agents);
  const queries = queriesFrom(bullets);
  assert.ok(queries.length >= 150, `${queries.length} queries`);
  // The new build: every agent with bullets at reader with a ledger; its memory markdown leaves the index.
  const claimAgents = corpus.agents.filter((a) => (bullets[a] ?? []).length);
  for (const a of claimAgents) {
    fs.mkdirSync(path.join(newHive, 'agents', a, 'memory', 'claims'), { recursive: true });
    fs.writeFileSync(path.join(newHive, 'agents', a, 'memory', 'claims', '2026-10.jsonl'), '');
  }
  fs.writeFileSync(path.join(newHive, 'memory-sources.json'), JSON.stringify({ topLevel: [], include: {}, ledger: Object.fromEntries(claimAgents.map((a) => [a, 'reader'])) }));
  const script = path.join(__dirname, 'g32-latency.cjs');
  const oldRes = await runDrill({ tree: OLD, hive: oldHive, home: path.join(JAIL, 'old-home'), script, args: { claims: false, queries }, timeoutMs: 40 * 60_000 });
  assert.equal(oldRes.ok, true, JSON.stringify(oldRes).slice(0, 2000));
  const newRes = await runDrill({ tree: NEW, hive: newHive, home: path.join(JAIL, 'new-home'), script, args: { claims: true, claimAgents, bullets, queries }, timeoutMs: 40 * 60_000 });
  assert.equal(newRes.ok, true, JSON.stringify(newRes).slice(0, 2000));
  const report = { at: new Date().toISOString(), corpus, queries: queries.length, old: oldRes, new: newRes, ratioP95: newRes.p95 / oldRes.p95, gate: '<= 1.5' };
  fs.writeFileSync(process.env.CLAIMS_G32_REPORT || path.join(JAIL, 'g32.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ oldP95: oldRes.p95, newP95: newRes.p95, ratio: report.ratioP95, oldFound: oldRes.foundRate, newFound: newRes.foundRate, oldChunks: oldRes.counts.chunks, newChunks: newRes.counts.chunks, claims: newRes.claimCount }));
  assert.ok(newRes.p95 <= 1.5 * oldRes.p95, `p95 ${newRes.p95.toFixed(1)} ms vs ${oldRes.p95.toFixed(1)} ms (x${report.ratioP95.toFixed(2)})`);
  // G3.5 automated proxy (the labelled §4 parity run is the raters'): the phrase each query was cut
  // from is found in the top 5 at least as often on claim chunks as on markdown, within 5 points.
  assert.ok(newRes.foundRate >= oldRes.foundRate - 0.05, `G3.5 proxy: found ${(newRes.foundRate * 100).toFixed(1)}% vs ${(oldRes.foundRate * 100).toFixed(1)}%`);
});
