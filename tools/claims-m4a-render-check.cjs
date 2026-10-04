'use strict';
// Script-scored M4a check. Usage: node tools/claims-m4a-render-check.cjs <frozen-key.json> <views-dir>
// Expected view layout: <views-dir>/<agent>/memory.md and working-set.md. Outputs counts only.
const fs = require('node:fs');
const path = require('node:path');
function score(key, readView) {
  const items = (key.items || []).filter(x => x.changed === true);
  let fullPass = 0, workingPass = 0;
  for (const item of items) {
    const full = readView(item.agent, 'memory.md');
    const working = readView(item.agent, 'working-set.md');
    const current = String(item.current ?? '');
    const fullLines = full.split(/\r?\n/);
    const currentLines = fullLines.filter(line => current && line.includes(current) && /\bCURRENT\b/.test(line));
    const currentOk = currentLines.length === 1;
    const priorValues = Array.isArray(item.priorValues) ? item.priorValues : [];
    const priorOk = priorValues.every(value => {
      const line = fullLines.find(row => row.includes(String(value)));
      return !line || (/\bPRIOR\b/.test(line) && /\d{4}-\d{2}-\d{2}/.test(line));
    });
    const priorIds = (item.entryIds || []).filter(id => id !== item.current);
    const idLabelsOk = priorIds.every(id => {
      const line = full.split(/\r?\n/).find(row => row.includes(String(id)));
      return !line || (/\bPRIOR\b/.test(line) && /\d{4}-\d{2}-\d{2}/.test(line));
    });
    if (currentOk && priorOk && idLabelsOk) fullPass++;
    const currentShown = current && working.includes(current);
    const topic = String(item.topic ?? '');
    const pointerLine = working.split(/\r?\n/).find(line => topic && line.includes(topic) && /\[history: memory\.md#.+\]/.test(line));
    const anchor = (item.historyAnchor && working.includes(`[history: memory.md#${item.historyAnchor}]`)) || pointerLine;
    if (currentShown || anchor) workingPass++;
  }
  return { frozenChangedFacts: items.length, fullViewPass: fullPass, workingSetPass: workingPass,
    fullViewScore: items.length ? fullPass / items.length : null, workingSetScore: items.length ? workingPass / items.length : null };
}
module.exports = { score };
if (require.main === module) {
  const [keyFile, viewsDir] = process.argv.slice(2);
  if (!keyFile || !viewsDir) { console.error('usage: node tools/claims-m4a-render-check.cjs <frozen-key.json> <views-dir>'); process.exit(2); }
  const key = JSON.parse(fs.readFileSync(path.resolve(keyFile), 'utf8'));
  const result = score(key, (agent, name) => fs.readFileSync(path.join(path.resolve(viewsDir), agent, name), 'utf8'));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.fullViewPass !== result.frozenChangedFacts || result.workingSetPass !== result.frozenChangedFacts) process.exitCode = 1;
}
