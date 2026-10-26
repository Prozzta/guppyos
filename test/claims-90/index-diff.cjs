'use strict';
/**
 * CLAIMS-90 m3 (Jim): what the re-sync changed in the index, at content level. Electron as Node
 * (the tree's better-sqlite3 is built for it). Opens both files read-only and, per table, compares
 * the row count and a sha256 over every row in rowid order (vector tables through their shadow
 * tables). Prints counts and shas only: index rows hold memory text.
 *   electron-as-node index-diff.cjs <tree> <index as copied> <index after the re-sync>
 */
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const [tree, before, after] = process.argv.slice(2);
const Database = createRequire(path.join(tree, 'package.json'))('better-sqlite3');

function tables(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const out = {};
    const names = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    for (const { name, sql } of names) {
      if (/^CREATE VIRTUAL TABLE/i.test(sql || '')) { out[name] = { virtual: true }; continue; }
      const h = crypto.createHash('sha256');
      let rows = 0;
      const cols = db.prepare(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).all().map((c) => c.name);
      let order = 'rowid';
      try { db.prepare(`SELECT rowid FROM "${name}" LIMIT 1`).all(); } catch { order = cols.map((c) => `"${c}"`).join(', '); }
      for (const r of db.prepare(`SELECT * FROM "${name}" ORDER BY ${order}`).iterate()) {
        rows++;
        h.update(JSON.stringify(cols.map((c) => (Buffer.isBuffer(r[c]) ? r[c].toString('base64') : r[c]))));
        h.update('\n');
      }
      out[name] = { rows, sha256: h.digest('hex') };
    }
    return out;
  } finally { db.close(); }
}

const a = tables(before);
const b = tables(after);
const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
const changed = names.filter((n) => JSON.stringify(a[n]) !== JSON.stringify(b[n]));
/** For a changed table: per column, how many rows (matched by rowid) differ. Counts only. */
function columnDiff(name) {
  const da = new Database(before, { readonly: true, fileMustExist: true });
  const db = new Database(after, { readonly: true, fileMustExist: true });
  try {
    const q = `SELECT rowid AS _r, * FROM "${name.replace(/"/g, '""')}"`;
    const rb = new Map(db.prepare(q).all().map((r) => [r._r, r]));
    const cols = {};
    let unmatched = 0;
    for (const r of da.prepare(q).iterate()) {
      const s = rb.get(r._r);
      if (!s) { unmatched++; continue; }
      for (const c of Object.keys(r)) if (c !== '_r' && JSON.stringify(r[c]) !== JSON.stringify(s[c])) cols[c] = (cols[c] || 0) + 1;
    }
    return { columnsDiffering: cols, unmatched };
  } catch (e) { return { error: String(e.message).slice(0, 120) }; } finally { da.close(); db.close(); }
}

console.log(JSON.stringify({ tables: names.length, changed: changed.map((n) => ({ table: n, before: a[n] ?? null, after: b[n] ?? null, ...(a[n]?.rows && b[n]?.rows ? columnDiff(n) : {}) })) }, null, 1));
