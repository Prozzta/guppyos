'use strict';

/**
 * Mutant runner for CLAIMS-90 M2 (one row per claim in the live search view: its matched part, the
 * superseded claims behind it counted along its chain). Each mutant injects ONE named regression into ONE src/ file, runs
 * the M2 test files (the pure unit tests, the Electron scenario, native-memory), and must turn them RED.
 * An anchor that is missing or not unique is INERT and counts as a failure of the run. Same engine as
 * claims90-m1-mutants.cjs. HEAVY: run it in the heavy slot (it spawns Electron per mutant).
 *
 *   node test/tools/claims90-m2-mutants.cjs [name-prefix]
 *
 * This file RUNS when loaded (no main guard): check its syntax with `node --check`, never require().
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { recover, mutateFile, restoreFile } = require('./mutant-runner-helper.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
recover(ROOT);
if (process.argv.includes('--recover-only')) process.exit(0);
const TESTS = ['test/claims90-m2-one-per-key.test.cjs', 'test/claims90-m2-keys.test.cjs', 'test/native-memory.test.cjs'];
const STORE = 'src/main/nativeMemory/store.ts';
const ENGINE = 'src/main/nativeMemory/engine.ts';
const FORMAT = 'src/main/nativeMemory/format.ts';

const CHUNKS = 'src/main/claims/chunks.ts';

const MUTANTS = [
  ['a a claim met again (another part) is shown again (no collapse)', STORE, 'if (seen.has(c.r.claim_id)) continue;', 'if (false) continue;'],
  ['b priors are never counted', STORE, 'out.push({ f: c.f, r: c.r, priors: priors(c.r) });', 'out.push({ f: c.f, r: c.r, priors: 0 });'],
  ['c markdown rows are dropped from the live view', STORE, 'if (!c.r.claim_id) { out.push({ f: c.f, r: c.r, priors: 0 }); continue; }', 'if (!c.r.claim_id) continue;'],
  ['d an uncertain (superseded?) link is counted as a prior', STORE, "SELECT claim_id FROM claim_status WHERE superseded_by = @id AND status = 'superseded'", 'SELECT claim_id FROM claim_status WHERE superseded_by = @id'],
  ['e the chain is followed one link deep only', STORE, 'JOIN chain ON s.superseded_by = chain.id', 'JOIN chain ON 0'],
  ['f an older index never gets the superseded_by column', STORE, "if (!statusCols.includes('superseded_by'))", 'if (false)'],
  ['g a link-only change is not a status row', STORE, '(was?.by ?? null) !== (ps[0].supersededBy ?? null)', 'false'],
  ['h a status row keeps the old link', STORE, 'superseded_by = excluded.superseded_by', 'superseded_by = superseded_by'],
  ['i the link is dropped when a claim is first indexed', STORE, 'setStatus.run(p.claimId, p.status, visOf(p.status), p.at, p.supersededBy ?? null);', 'setStatus.run(p.claimId, p.status, visOf(p.status), p.at, null);'],
  ['j chunksFor drops the supersession link', CHUNKS, 'supersededBy: st.supersededBy ?? null,', 'supersededBy: null,'],
  ['k the Versions line is never printed', FORMAT, 'if (h.priors) L.push(`      Versions:', 'if (false) L.push(`      Versions:'],
  ['l redactHit drops priors', ENGINE, '{ priors: h.priors }', '{}'],
  ['m the collapse also runs in history / all mode', STORE, "if (mode === 'live') {", 'if (true) {'],
];

const prefix = process.argv[2] || '';
const selected = MUTANTS.filter(([name]) => name.startsWith(prefix));
let killed = 0; let inert = 0;
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
  const mutatedLf = lf.slice(0, at) + to + lf.slice(at + from.length);
  const mutated = crlf ? mutatedLf.replace(/\n/g, '\r\n') : mutatedLf;
  mutateFile(ROOT, abs, original, mutated);
  let r;
  try {
    r = spawnSync(process.execPath, ['--test', ...TESTS], { cwd: ROOT, encoding: 'utf8', timeout: 900_000 });
  } finally {
    restoreFile(ROOT, abs, original);
  }
  const dead = r.status !== 0;
  if (dead) killed++;
  const fails = (String(r.stdout).match(/^# fail (\d+)/m) || [])[1] ?? '?';
  console.log(`${dead ? 'KILLED  ' : 'SURVIVED'}  ${name}  (failing tests: ${fails})`);
}
console.log(`census: ${killed}/${selected.length} killed, ${inert} INERT`);
process.exitCode = killed === selected.length && inert === 0 ? 0 : 1;
