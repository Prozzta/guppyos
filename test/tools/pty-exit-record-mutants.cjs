'use strict';

// ANDY-PTY-EXIT-2049: the hand-mutant census of the unrequested-exit record (src/main/ptyExitRecord.ts,
// its pty.ts hand-over and its index.ts wiring), committed so the audit can re-run it. Each mutant
// damages ONE source line at a unique anchor and must make test/pty-exit-record-198.test.cjs fail AT
// ITS OWN NAMED TEST; a survivor, a kill elsewhere or a missing anchor fails the census. A heavy job
// (bench): run it in a heavy slot.
//   node test/tools/pty-exit-record-mutants.cjs
// Each file is restored in a finally (CRLF kept).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const { recover, mutateFile, restoreFile, checkAnchors } = require('./mutant-runner-helper.cjs');
recover(ROOT);
if (process.argv.includes('--recover-only')) process.exit(0);
const TEST = 'test/pty-exit-record-198.test.cjs';
const REC = 'src/main/ptyExitRecord.ts';
const PTY = 'src/main/pty.ts';
const INDEX = 'src/main/index.ts';
const at = (title) => new RegExp(`not ok \\d+ - ${title.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`);
const TAKEN = at('X1/X2: an unrequested end hands evidence; the observer takes the mirror and pty.ts leaves it to the taker');
const UNTAKEN = at('X3: an untaken mirror is disposed at the end as before; a take after the end gets nothing');
const KILL = at('X1: a requested end (kill, explicit teardown) hands no evidence and disposes the mirror');
const DECODE = at('X12: exit codes decode, signed or unsigned NTSTATUS alike');
const CODEX = at('X5: a Codex rollout tail names the last call, its args (clipped) and that no output came (Dwight 04:58:14)');
const STALE = at('X4: a transcript held open with a stale mtime: the record carries the mtime AND the newer last-row time');
const LOGTAIL = at('Codex log tail: by pid when a row carries it, else the process last logging within this life');
const LOCKED = at('X10: a locked or missing logs DB is skipped and named; the handle is closed');
const KIDS = at('X6: children at exit follow the own-procs rule: a recycled parent pid never adopts a stranger');
const CAP = at('X7: a huge record is cut under 64 KB, each cut named');
const KEEP = at('X8: records go to <hive>/exits/<agent>/ and only the newest 20 stay; a path-like agent id is refused');
const HUNG = at('X9: a hung or throwing screen read still disposes the mirror and still writes the record');
const REDACT = at('X16: a secret-shaped child commandLine, screen row and raw tail come out [redacted] (Jim S1: <hive>/exits is floor-readable)');
const NOISE = at('X17: noise Codex log rows (token_count, item_completed, token_usage) are skipped; the newest n others stay (Jim N1)');
const HEADROW = at('X18: a raw tail pty.ts cut drops its partial head row, so a key cut at the head leaves no fragment (Jim N2)');
const WRAPPED = at('X19: a key wrapped over screen rows leaves no fragment; the rows it spans are blanked, the others stay (Jim N3)');
const TOPROW = at('X20: the top screen row may continue a key from above the viewport: its leading key-shaped run is redacted');
const PEMSCREEN = at('X22: a PEM key on screen leaves no body row, though each row is shorter than cols (Jim interim)');
const PEMTAIL = at('X23: a raw tail cut inside a PEM header drops the orphaned body up to its footer');
const PEMTOP = at('X24: a screen that opens mid-PEM (BEGIN above the viewport) blanks every row up to the footer');
const WIRE = at('X13/X14: main records only an unrequested, non-installer end, takes its facts synchronously and fires and forgets');

const MUTANTS = [
  ['X1 an explicit end hands evidence', PTY, '    if (!explicit) {\n', '    if (true) {\n', KILL],
  ['X2 a taken mirror is still disposed by pty.ts', PTY, 'takeMirror: () => { const m = mirror; mirror = undefined; return m; }', 'takeMirror: () => mirror', TAKEN],
  ['X3 an untaken mirror is not disposed', PTY, '    mirror?.dispose();\n    mirror = undefined;\n', '    mirror = undefined;\n', UNTAKEN],
  ['X4 freshness from the mtime', REC, "...transcriptTail(buf.toString('utf8'), provider, n) };", "...transcriptTail(buf.toString('utf8'), provider, n), lastRowAt: new Date(st.mtimeMs).toISOString() };", STALE],
  ['X5 a call output is never matched', REC, 'hasOutput: !!id && answered.has(id)', 'hasOutput: false', CODEX],
  ['X6 a stranger with a recycled parent pid counts', REC, "typeof r.createdMs !== 'number' || r.createdMs < parentBorn", "typeof r.createdMs !== 'number'", KIDS],
  ['X7 the size cap is not applied', REC, 'if (size() <= maxBytes) break;', 'if (true) break;', CAP],
  ['X8 no pruning to the newest kept', REC, 'all.slice(0, Math.max(0, all.length - kept))', 'all.slice(0, 0)', KEEP],
  ['X9 a hung screen read leaves the mirror', REC, '    try { d.disposeScreen(); } catch { /* disposed */ }\n', '', HUNG],
  ['X10 a codex log error escapes', REC, "  } catch (e) {\n    return { file, process: null, match: 'none', rows: [],", "  } catch (e) {\n    throw e;\n    return { file, process: null, match: 'none', rows: [],", LOCKED],
  ['X11 the window rule ignores the exit time', REC, 'procs.filter((r) => r.hi <= Math.ceil(exitAt / 1000) + 5)', 'procs.filter(() => true)', LOGTAIL],
  ['X12 signed NTSTATUS not decoded', REC, 'const u = code >>> 0;', 'const u = code;', DECODE],
  ['X13 main records a requested end', INDEX, 'if (!e.explicit && e.evidence && !pendingInstallRelaunch.has(e.id)) {', 'if (e.evidence && !pendingInstallRelaunch.has(e.id)) {', WIRE],
  ['X14 main records an installer relaunch', INDEX, 'if (!e.explicit && e.evidence && !pendingInstallRelaunch.has(e.id)) {', 'if (!e.explicit && e.evidence) {', WIRE],
  ['X15 the last hook event is never stamped', INDEX, '    if (agentId && event) hookSeenEvent.set(agentId, event);', '', WIRE],
  ['X16 free text is clipped but not redacted', REC, "  const t = redactSecrets(typeof s === 'string' ? s : s === undefined ? '' : JSON.stringify(s) ?? '');", "  const t = (typeof s === 'string' ? s : s === undefined ? '' : JSON.stringify(s) ?? '');", REDACT],
  ['X17 noise Codex log rows are kept', REC, "const signal = all.filter((r) => !CODEX_LOG_NOISE.test(`${r.target} ${r.body ?? ''}`));", 'const signal = all;', NOISE],
  ['X18 the head row of a cut tail is kept', REC, "    const nl = t.indexOf('\\n'); t = nl < 0 ? '' : t.slice(nl + 1);\n", '', HEADROW],
  ['X19 rows are redacted one by one only', REC, "  if (whole !== out.map((l, k) => l + sep[k]).join('')) {\n", '  if (false) {\n', WRAPPED],
  ['X20 the top row\'s leading key run is kept', REC, "  if (out.length) out[0] = out[0].replace(KEY_RUN_AT_START, '[redacted]');\n", '', TOPROW],
  ['X21 a short row\'s boundary counts as a wrap', REC, 'const mayWrap = (l: string) => !cols || l.length >= cols || /[^\\x00-\\x7f]/.test(l);', 'const mayWrap = (l: string) => true;', WRAPPED],
  ['X22 a short row\'s boundary is never checked', REC, 'if (redactSecrets(all.slice(0, at)) + sep[k] + ', "if (sep[k] === '' && redactSecrets(all.slice(0, at)) + sep[k] + ", PEMSCREEN],
  ['X23 a cut tail keeps an orphaned PEM body', REC, "    if (n) t = ['[redacted]', ...rows.slice(n)].join('\\n');\n", '', PEMTAIL],
  ['X24 screen rows opening mid-PEM are kept', REC, "  for (let k = 0, n = orphanPemRows(lines); k < n; k++) out[k] = '[redacted]';\n", '', PEMTOP],
  ['X25 a wide-char row never wraps', REC, 'const mayWrap = (l: string) => !cols || l.length >= cols || /[^\\x00-\\x7f]/.test(l);', 'const mayWrap = (l: string) => !cols || l.length >= cols;', WRAPPED]
];

checkAnchors(ROOT, MUTANTS.map(([name, file, from]) => ({ name, file, from })));
const run = () => spawnSync(process.execPath, ['--test', TEST], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 300_000 });
const base = run();
if (base.status !== 0) {
  console.log(`BASELINE RED: ${TEST} fails unmutated, so no mutant proves anything.`);
  process.exit(1);
}
let bad = 0;
for (const [name, rel, from, to, dies] of MUTANTS) {
  const abs = path.join(ROOT, rel);
  const original = fs.readFileSync(abs, 'utf8');
  const source = original.replace(/\r\n/g, '\n');
  const pos = source.indexOf(from);
  if (pos < 0 || source.indexOf(from, pos + 1) >= 0) {
    console.log(`INERT ${name} (anchor ${pos < 0 ? 'missing' : 'not unique'})`);
    bad += 1;
    continue;
  }
  let mutated = source.slice(0, pos) + to + source.slice(pos + from.length);
  if (original.includes('\r\n')) mutated = mutated.replace(/\n/g, '\r\n');
  let r;
  try {
    mutateFile(ROOT, abs, original, mutated);
    r = run();
  } finally {
    restoreFile(ROOT, abs, original);
  }
  const named = dies.test(`${r.stdout}${r.stderr}`);
  const killed = r.status !== 0 && named;
  if (!killed) bad += 1;
  console.log(`${killed ? 'KILLED' : r.status !== 0 ? 'KILLED ELSEWHERE' : 'SURVIVED'} ${name}`);
}
console.log(bad ? `${bad} of ${MUTANTS.length} not killed at their named test` : `all ${MUTANTS.length} killed`);
process.exitCode = bad ? 1 : 0;
