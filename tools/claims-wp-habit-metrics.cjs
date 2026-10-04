'use strict';
// Usage: node tools/claims-wp-habit-metrics.cjs <log.jsonl>
// Prints counts only; claim ids, notes and replacement reasons are never emitted.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const Module = require('node:module');
const file = process.argv[2];
if (!file) { console.error('usage: node tools/claims-wp-habit-metrics.cjs <log.jsonl>'); process.exit(2); }
const rows = fs.readFileSync(path.resolve(file), 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
const source = fs.readFileSync(path.join(__dirname, '..', 'src/main/claims/writeHabit.ts'), 'utf8');
const js = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
const mod = new Module(path.join(__dirname, '..', 'src/main/claims/writeHabit.ts'), module);
mod.filename = path.join(__dirname, '..', 'src/main/claims/writeHabit.ts'); mod.paths = module.paths; mod._compile(js, mod.filename);
process.stdout.write(`${JSON.stringify(mod.exports.summarizeWriteHabit(rows), null, 2)}\n`);
