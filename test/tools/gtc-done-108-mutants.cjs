'use strict';

/**
 * Mutant runner for the GOD-TERMINAL-CONTROL 108 done pin (test/gtc-done-108.test.cjs). Each mutant
 * injects ONE named regression into src/main/termControl.ts and must turn the pin RED. An anchor
 * that is missing or not unique is INERT and counts as a failure of the run. Same engine as
 * gtc-m4-mutants.cjs.
 *
 *   node test/tools/gtc-done-108-mutants.cjs [name-prefix]
 */
const fs = require('node:fs');
const path = require('node:path');
const { recover, mutateFile, restoreFile, checkAnchors } = require('./mutant-runner-helper.cjs');
const { runTests, verdict, requireBaseline } = require('./mutant-tap.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
recover(ROOT);
if (process.argv.includes('--recover-only')) process.exit(0);
const TESTS = ['test/gtc-done-108.test.cjs'];
const TC = 'src/main/termControl.ts';

/** Output moved in the last 200 ms: the terminal is busy (what a screen gate reads as not ready). */
const BUSY_NOW = 'const g0 = this.deps.outputGeneration(ptyId); await this.deps.sleep(200); const busyNow = this.deps.outputGeneration(ptyId) !== g0;';

const MUTANTS = [
  ['M1 typed text goes through a readiness gate (refused while the turn streams)', TC,
    '    const before = await this.deps.readScreen(ptyId);\n',
    `    const before = await this.deps.readScreen(ptyId);\n    if (action !== 'keys') { ${BUSY_NOW} if (busyNow) { this.logRow({ by, agent, action, ok: false, error: 'not ready' }); return { status: 409, body: { ok: false, line: 'refused: not ready' } }; } }\n`],
  ['M2 keyBytes drops esc', TC,
    "    case 'esc': return '\\x1b';\n", ''],
  ['M3 the write is skipped while the terminal is busy (and still reported ok)', TC,
    '    for (const w of writes) {\n      if (w.gapBeforeMs) await this.deps.sleep(w.gapBeforeMs);\n      const r = this.deps.write(ptyId, w.data);',
    `    ${BUSY_NOW}\n    for (const w of writes) {\n      if (w.gapBeforeMs) await this.deps.sleep(w.gapBeforeMs);\n      const r = busyNow ? { ok: true } : this.deps.write(ptyId, w.data);`]
];

// THE BASELINE MUST BE GREEN.
checkAnchors(ROOT, MUTANTS.map(([name, file, from]) => ({ name, file, from })));
requireBaseline(runTests(ROOT, TESTS, { timeout: 0 }), 'the unmutated GTC done pin');

const only = process.argv[2];
const selected = MUTANTS.filter(([name]) => !only || name.startsWith(only));
let killed = 0;
let inert = 0;
for (const [name, file, from, to] of selected) {
  const abs = path.join(ROOT, file);
  const original = fs.readFileSync(abs, 'utf8');
  const crlf = original.includes('\r\n');
  const lf = original.replace(/\r\n/g, '\n');
  const at = lf.indexOf(from);
  if (at < 0 || lf.indexOf(from, at + 1) >= 0) {
    inert++;
    console.log(`INERT     ${name}  (anchor ${at < 0 ? 'missing' : 'not unique'} in ${file})`);
    continue;
  }
  let mutated = lf.slice(0, at) + to + lf.slice(at + from.length);
  if (crlf) mutated = mutated.replace(/\n/g, '\r\n');
  try {
    mutateFile(ROOT, abs, original, mutated);
    const r = runTests(ROOT, TESTS, { timeout: 300_000 });
    const v = verdict(r); // NO-RESULT (the run never reported) is loud: neither a kill nor a survivor
    if (v === 'KILLED') killed++;
    console.log(`${v.padEnd(9)} ${name}  (${v === 'NO-RESULT' ? r.why : `failing tests: ${r.fail}`})`);
  } finally {
    restoreFile(ROOT, abs, original);
  }
}
console.log(`\n${killed}/${selected.length} killed${inert ? `, ${inert} INERT` : ''}`);
process.exit(killed === selected.length ? 0 : 1);
