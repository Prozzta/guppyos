'use strict';
/**
 * CLAIMS-90 search S3/S4 (god 33b32e): over a file of search queries ({query} per JSON line), how many name a card,
 * a card-owned branch or a release (searchTargets.ts over the hive's tasks.json and claim keys), and for how many
 * every named target has a brief (main's claimCardLeadOver, the same call the search makes). Query side only: the
 * hits add more targets at run time, so these are the floor. Counts only; --list prints the queries naming nothing.
 *
 *   node test/tools/claims90-s34-count.cjs <queries.jsonl> <hive root> [--list]
 */
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const loadTs = require(path.join(REPO, 'test', 'load-ts.cjs'));
const { readLedgers, readTasks, hiveCardLead } = require('./claims90-hive-read.cjs');

async function main() {
  const [file, root] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!file || !root) { console.error('usage: claims90-s34-count.cjs <queries.jsonl> <hive root> [--list]'); process.exit(2); }
  const { targetIndex, targetsIn } = loadTs('src/main/claims/searchTargets.ts');
  const keys = Object.values(readLedgers(root)).flat().filter((r) => r.t === 'claim').map((r) => r.key);
  const ix = targetIndex(readTasks(root).map((t) => t && t.id), keys);
  const lead = hiveCardLead(root);
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l).query);
  const briefs = new Map();
  const briefOf = async (term) => {
    if (!briefs.has(term)) briefs.set(term, ((await lead([term]))[term.toLowerCase()] ?? []).length > 0);
    return briefs.get(term);
  };
  const tally = () => ({ queries: 0, named: 0, card: 0, release: 0, allBrief: 0, someBrief: 0, noBrief: 0 });
  const all = tally(); const uniq = tally(); const seen = new Set(); const none = [];
  for (const q of rows) {
    const ts = targetsIn([q], ix);
    const have = [];
    for (const t of ts) have.push(await briefOf(t.term));
    for (const s of seen.has(q) ? [all] : [all, uniq]) {
      s.queries++;
      if (!ts.length) continue;
      s.named++;
      if (ts.some((t) => t.kind === 'card')) s.card++;
      if (ts.some((t) => t.kind === 'release')) s.release++;
      if (have.every(Boolean)) s.allBrief++; else if (have.some(Boolean)) s.someBrief++; else s.noBrief++;
    }
    if (!ts.length && !seen.has(q)) none.push(q);
    seen.add(q);
  }
  console.log(`index: ${ix.cards.size} cards, ${ix.releases.size} releases`);
  for (const [name, s] of [['rows', all], ['distinct', uniq]]) {
    console.log(`${name}: ${s.queries}; naming a target ${s.named} (card ${s.card}, release ${s.release}); every named target has a brief ${s.allBrief}, some ${s.someBrief}, none ${s.noBrief}; naming nothing ${s.queries - s.named}`);
  }
  if (process.argv.includes('--list')) for (const q of none) console.log(`  none: ${q}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
