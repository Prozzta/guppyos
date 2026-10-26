'use strict';
/**
 * CLAIMS-90 L7 (god 985a82): the read-only claim inputs of a hive folder, for the auditor's tools
 * (claims90-get.cjs, claims90-search.cjs --hive <root>). The ledgers are read raw (the auditor's copy has no MAC
 * key: every parseable claim / event row counts, chain 'ok'), and everything above them runs main's own code:
 * claimCardLeadOver over a ClaimReadDeps, exactly as main answers the worker's card-lead ask, then the engine's
 * cardLeadsFor and formatSearch, so the tool's text is byte-for-byte the engine's for the same hits.
 */
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const loadTs = require(path.join(REPO, 'test', 'load-ts.cjs'));

/** Raw ledger lines of every agent with a claims folder: { [agentId]: LedgerRec[] }. */
function readLedgers(root) {
  const out = {};
  const agents = path.join(root, 'agents');
  let ids = [];
  try { ids = fs.readdirSync(agents); } catch { return out; }
  for (const id of ids) {
    const dir = path.join(agents, id, 'memory', 'claims');
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort(); } catch { continue; }
    const recs = [];
    for (const f of files) {
      for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { const v = JSON.parse(line); if (v && typeof v.id === 'string' && (v.t === 'claim' || v.t === 'event')) recs.push(v); } catch { /* a torn or foreign line */ }
      }
    }
    if (recs.length) out[id] = recs;
  }
  return out;
}

/** tasks.json's rows (an array, or { tasks: [...] }); none when the file is missing. */
function readTasks(root) {
  try { const t = JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8')); return Array.isArray(t) ? t : (t.tasks ?? []); } catch { return []; }
}

/** The ClaimReadDeps main builds for the served hive (readWiring.ts), over the folder's raw ledgers. */
function hiveReadDeps(root) {
  const ledgers = readLedgers(root);
  return {
    root,
    store: { readLedger: (a) => ({ records: ledgers[a] ?? [], torn: null, chain: 'ok' }) },
    agents: () => Object.keys(ledgers),
    tasks: () => readTasks(root),
  };
}

/** The engine's cardLead dep over a hive folder: main's claimCardLeadOver, unchanged. */
function hiveCardLead(root) {
  const { claimCardLeadOver } = loadTs('src/main/claims/readWiring.ts');
  const deps = hiveReadDeps(root);
  return async (cards) => claimCardLeadOver(deps, cards);
}

/** The search text the engine prints for these hits: with a hive root the card briefs come from it (L7), without
 *  one the hits print as before (no leads). The same engine helpers on both sides, so the texts agree byte for byte. */
async function searchTextOver(root, query, flags, hits) {
  const { cardLeadsFor } = loadTs('src/main/nativeMemory/engine.ts');
  const { formatSearch } = loadTs('src/main/nativeMemory/format.ts');
  return formatSearch(query, flags, hits, await cardLeadsFor(hits, root ? hiveCardLead(root) : undefined));
}

module.exports = { readLedgers, readTasks, hiveReadDeps, hiveCardLead, searchTextOver };
