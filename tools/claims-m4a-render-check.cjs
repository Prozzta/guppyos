'use strict';
// Usage: node tools/claims-m4a-render-check.cjs <frozen-key.json> <views-dir> <entry-claim-map.json>
// The replay writes entry-claim-map.json: { [agent]: { [entryId]: { claimId?, text } } }.
// Outputs counts only; the frozen key and replay mapping are the only scoring inputs.
const fs = require('node:fs');
const path = require('node:path');

const DATE_LABEL = /^- PRIOR — \d{4}-\d{2}-\d{2} — /;
const currentLabel = /^- CURRENT — \d{4}-\d{2}-\d{2} — /;

function score(key, readView, entryClaims = {}) {
  const items = (key.items || []).filter(x => x.changed === true);
  let fullPass = 0, workingPass = 0;
  for (const item of items) {
    const fullLines = readView(item.agent, 'memory.md').split(/\r?\n/);
    const workingLines = readView(item.agent, 'working-set.md').split(/\r?\n/);
    const map = entryClaims[item.agent] || {};
    const locators = [...new Set([...(item.entryIds || []), item.current].filter(x => typeof x === 'string'))];
    const facts = locators.map(entryId => ({ entryId, ...(map[entryId] || {}) }));
    const current = facts.find(f => f.entryId === item.current);
    const priors = facts.filter(f => f.entryId !== item.current);
    // Jim W5: a rendered entry keeps only its FIRST line on the labelled bullet (later lines are
    // indented continuations), so a text-only arm matches the entry's first non-empty line.
    const lead = (text) => (typeof text === 'string' ? text.split(/\r?\n/).map(l => l.trim()).find(Boolean) : undefined);
    const taggedLines = (fact) => fact.claimId
      ? fullLines.filter(line => line.includes(`[c:${fact.claimId}]`))
      : (lead(fact.text) ? fullLines.filter(line => line.includes(lead(fact.text))) : []);
    const currentLines = current ? taggedLines(current) : [];
    const currentOk = currentLines.length === 1 && currentLabel.test(currentLines[0]);
    const priorsOk = priors.every(fact => {
      const lines = taggedLines(fact);
      return lines.every(line => DATE_LABEL.test(line));
    });
    if (currentOk && priorsOk) fullPass++;

    const shownLine = current && (current.claimId
      ? workingLines.find(line => line.includes(`[c:${current.claimId}]`) && /\[status:current\]/.test(line))
      : lead(current.text) && workingLines.find(line => line.includes(lead(current.text))));
    const anchor = current?.claimId ? `memory.md#claim-history-${current.claimId}` : null;
    const pointer = anchor
      ? workingLines.some(line => line.includes(anchor) && /history:/i.test(line))
      : workingLines.some(line => item.topic && line.startsWith(`- ${item.topic} history: memory.md#`));
    // Clause 3 (design §8): the working set EITHER shows the current version OR carries a per-fact
    // history pointer (Jim's step-2 re-audit, W1). Text-only arm A uses the same rule. That the
    // product also suffixes a shown current with its pointer is pinned by the views render tests.
    if (shownLine || pointer) workingPass++;
  }
  return { frozenChangedFacts: items.length, fullViewPass: fullPass, workingSetPass: workingPass,
    fullViewScore: items.length ? fullPass / items.length : null, workingSetScore: items.length ? workingPass / items.length : null };
}
module.exports = { score };
if (require.main === module) {
  const [keyFile, viewsDir, mappingFile] = process.argv.slice(2);
  if (!keyFile || !viewsDir || !mappingFile) { console.error('usage: node tools/claims-m4a-render-check.cjs <frozen-key.json> <views-dir> <entry-claim-map.json>'); process.exit(2); }
  const key = JSON.parse(fs.readFileSync(path.resolve(keyFile), 'utf8'));
  const entryClaims = JSON.parse(fs.readFileSync(path.resolve(mappingFile), 'utf8'));
  const result = score(key, (agent, name) => fs.readFileSync(path.join(path.resolve(viewsDir), agent, name), 'utf8'), entryClaims);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.fullViewPass !== result.frozenChangedFacts || result.workingSetPass !== result.frozenChangedFacts) process.exitCode = 1;
}
