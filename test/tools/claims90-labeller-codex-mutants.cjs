'use strict';
/**
 * Census for CLAIMS-90 T6 labeller --provider codex (god 495956, Jim 475eab). Each mutant injects ONE named regression
 * into labeller-codex.cjs or labeller.cjs, runs the codex labeller test, and must turn it RED. A missing or non-unique
 * anchor is INERT and fails the run. The claude path is judged by the existing labeller test, run unmutated at the end.
 *
 *   node test/tools/claims90-labeller-codex-mutants.cjs [name-prefix]
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const CX = 'test/claims-90/labeller-codex.cjs';
const LAB = 'test/claims-90/labeller.cjs';
const M = [
  // Jim: an outside read gives INVALID.
  ['O1 an outside path is judged inside', CX, "    if (G.where(p, jail) === 'outside') return { place: 'outside', path: p, reason: 'a path outside the jail' };\n", ''],
  ['O2 an outside call is not INVALID', CX, '  if (a.outside) return ', '  if (false) return '],
  ['O3 env reach is not judged', CX, '  if (reach) return ', '  if (false) return '],
  // Jim: an env leak gives INVALID.
  ['E1 codexEnv keeps hive keys', CX, '  for (const [k, v] of Object.entries(base)) if (!LEAK_KEY.test(k)) env[k] = v;', '  for (const [k, v] of Object.entries(base)) env[k] = v;'],
  ['E2 codexEnv keeps hive PATH dirs', CX, '.filter((d) => d && !HIVE_DIR.test(d))', '.filter((d) => d)'],
  ['E3 an env leak is not INVALID', CX, '  if (s.envLeaks.length) return ', '  if (false) return '],
  // Jim: no leftover session or CODEX_HOME; the login copy is gone after the run.
  ['H1 CODEX_HOME is not deleted', CX, "    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });\n", ''],
  ['H2 the login copy stays until the end', CX, "          if (!started && j.type === 'thread.started') { started = true; takeAuth(); continue; }", "          if (!started && j.type === 'thread.started') { started = true; continue; }"],
  ['H3 a codex session file is not INVALID', CX, '  if (s.leftovers.length) return ', '  if (false) return '],
  ['H4 the leftover scan sees nothing', CX, "  for (const sub of ['sessions', 'archived_sessions']) {", "  for (const sub of []) {"],
  ['H5 a left CODEX_HOME is not INVALID', CX, "  if (!s.homeRemoved || !s.authAbsentAfter) return ", '  if (false) return '],
  // Jim: a missing row gives INVALID.
  ['K1 a missing row is not INVALID', CX, '  if (key.missing.length) return ', '  if (false) return '],
  // Credentials never reach evidence; a refreshed login keeps the Human's login valid.
  ['C1 output is not redacted', CX, "  for (const s of secrets) if (t.includes(s)) { found++; t = t.split(s).join('[REDACTED]'); }", '  for (const s of secrets) if (t.includes(s)) { found++; }'],
  ['C2 a refreshed login is not written back', CX, '  if (latest && fs.readFileSync(authFile).equals(original)) {', '  if (false) {'],
  ['C3 a credential hit is not INVALID', CX, '  if (s.credentialHits) return ', '  if (false) return '],
  // The rest of the audit.
  ['A1 another tool is not INVALID', CX, '  if (a.otherItems.length) return ', '  if (false) return '],
  ['A2 a jail write is not INVALID', CX, "  if (s.jailChanged) return ", '  if (false) return '],
  ['A3 a project layer is not INVALID', CX, '  if (s.projectLayer.length) return ', '  if (false) return '],
  ['A4 the open log gets no codex rows', CX, "    fs.appendFileSync(openLog, res.audit.calls.map(", "    void (openLog, res.audit.calls.map("],
  // main wiring.
  ['W1 main appends before judging', LAB, '      const reason = CX.codexReason(s, key, own);\n      if (reason) return finish', '      const reason = null;\n      if (reason) return finish'],
  ['W2 codex gets the claude default model', LAB, "    o.model = o.model || null;\n    return o;", "    o.model = o.model || 'claude-opus-5-5';\n    return o;"],
];

const unit = (file) => spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
const lf = (s) => s.replace(/\r\n/g, '\n');
const prefix = process.argv[2] || '';
let killed = 0; let inert = 0; let n = 0;
for (const [name, file, from, to] of M.filter(([nm]) => nm.startsWith(prefix))) {
  n++;
  const abs = path.join(ROOT, file);
  const orig = fs.readFileSync(abs, 'utf8');
  const t = lf(orig);
  const at = t.indexOf(from);
  if (at < 0 || t.indexOf(from, at + 1) >= 0) { inert++; console.log(`INERT     ${name}  (anchor ${at < 0 ? 'missing' : 'not unique'} in ${file})`); continue; }
  let mutated = t.slice(0, at) + to + t.slice(at + from.length);
  if (orig.includes('\r\n')) mutated = mutated.replace(/\n/g, '\r\n');
  try {
    fs.writeFileSync(abs, mutated);
    const r = unit('test/claims-90-labeller-codex.test.cjs');
    const dead = r.status !== 0;
    if (dead) killed++;
    console.log(`${dead ? 'KILLED  ' : 'SURVIVED'}  ${name}  (failing tests: ${(String(r.stdout).match(/^# fail (\d+)/m) || [])[1] ?? '?'})`);
  } finally {
    fs.writeFileSync(abs, orig);
  }
}
const claude = unit('test/claims-90-labeller.test.cjs');
console.log(`claude labeller test unmutated: exit ${claude.status} ${(String(claude.stdout).match(/^# pass \d+/m) || [''])[0]}`);
console.log(`\n${killed}/${n} killed${inert ? `, ${inert} INERT` : ''}`);
process.exit(killed === n && claude.status === 0 ? 0 : 1);
