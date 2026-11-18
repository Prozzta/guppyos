'use strict';
/**
 * Fail-closed journal gate for maintenance tools that load repository source.
 *
 * The richer test helper owns recovery and live-runner coordination. A maintenance tool must
 * never load a tree while that helper has recorded mutated bytes: unlike a census child it is not
 * a measurement process. This module consequently rejects every nonempty journal, whether its
 * owner is live, dead, or unreadable.
 */
const fs = require('node:fs');
const path = require('node:path');

function assertUnmutated(root, gate = 'tools/load-ts') {
  const journal = path.join(root, '.mutant-runner-recovery.json');
  if (!fs.existsSync(journal)) return;
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(journal, 'utf8')); }
  catch (error) { throw new Error(`[${gate}] refusing to load source: invalid mutant recovery journal ${journal}: ${error.message}`); }
  const records = Array.isArray(parsed) ? parsed : parsed && parsed.records;
  if (!Array.isArray(records)) throw new Error(`[${gate}] refusing to load source: invalid mutant recovery journal ${journal}`);
  if (!records.length) return;
  const files = records.map((record) => String(record && record.file || '?')).join(', ');
  throw new Error(`[${gate}] refusing to load mutated source: mutant recovery journal is present. Journaled: ${files}`);
}

module.exports = { assertUnmutated };
