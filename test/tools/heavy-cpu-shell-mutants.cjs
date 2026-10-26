'use strict';

// CODEX-CMD-COMPUTED-SHELL-192: the hand-mutant census of the const-shell reader
// (src/main/codexHookMcp.ts) and the helper's once-parsed re-run (resources/heavyjob/guppy-heavyjob.cs),
// committed so a later audit can re-run it. Each mutant damages ONE line at a unique anchor and must
// make test/heavy-cpu-options-191.test.cjs fail AT ITS OWN NAMED TEST; a survivor, a kill elsewhere
// or a missing anchor fails the census. The LIVE test compiles the helper with the in-box csc.
// A heavy job (bench): run it in a heavy slot.
//   node test/tools/heavy-cpu-shell-mutants.cjs
// This runner restores the file itself in a finally.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..', '..');
const { recover, mutateFile, restoreFile } = require('./mutant-runner-helper.cjs');
recover(ROOT);
if (process.argv.includes('--recover-only')) process.exit(0);
const TEST = 'test/heavy-cpu-options-191.test.cjs';
const TS = 'src/main/codexHookMcp.ts';
const CS = 'resources/heavyjob/guppy-heavyjob.cs';
const CONST = /not ok \d+ - CODEX-CMD-COMPUTED-SHELL-192: a shell named by a const/;
const LIVE = /not ok \d+ - LIVE cmd: the `&` join line/;

const MUTANTS = [
  ['M11 the const is not read', TS, "key === 'shell' ? shellProp(src, code, span) : literalProp(span, key)", 'literalProp(span, key)', CONST],
  ['M12 a shadowing const is read', TS, 'if (decls.length !== 1 || decls[0].value === undefined) return undefined;', 'if (decls[0]?.value === undefined) return undefined;', CONST],
  ['S1 any other mention is allowed', TS, '    return undefined;\n  }\n  return decls[0].value;', '    continue;\n  }\n  return decls[0].value;', CONST],
  ['S2 a read outside a call is allowed', TS, 'const inCall = spans.some(([s, e]) => at > s && end < e);', 'const inCall = true;', CONST],
  ['S3 a template may touch the name', TS, "if (src.slice(m.index, m.index + m[0].length).includes('${') && new RegExp", 'if (false && new RegExp', CONST],
  ['S4 a continued expression is read', TS, 'if (j < src.length && after && ', 'if (j < src.length && ', CONST],
  ['S5 a member is the binding', TS, "if (p === '.') continue; // a member", "if (false) continue; // a member", CONST],
  ['S6 the key twice takes the last', TS, 'if (name !== undefined) return undefined; // the key twice', 'if (false) return undefined; // the key twice', CONST],
  ['S7 the declaration counts as a mention', TS, 'if (decls.some((d) => at > d.at && at < d.end)) continue;', 'if (false) continue;', CONST],
  ['S8 a line starting with in/instanceof ends the const', TS, '(?!(?:in|instanceof)(?![\\w$]))', '', CONST],
  ['M13 the helper re-parses the rest', CS, 'EscapeRest(cmdRest)', 'cmdRest', LIVE],
  ['H1 the percent stand-in is unset', CS, 'psi.EnvironmentVariables["GUPPY_HEAVYJOB_PCT"] = "%";', '', LIVE],
  ['H2 carets escaped inside quotes', CS, 'else if (!quoted && "^&|<>".IndexOf(c) >= 0)', 'else if ("^&|<>".IndexOf(c) >= 0)', LIVE],
  ['H3 percent left for the second parse', CS, 'if (c == \'%\') { sb.Append("%GUPPY_HEAVYJOB_PCT%"); continue; }', '', LIVE],
];

const local = fs.mkdtempSync(path.join(os.tmpdir(), 'hcpu-shell-mutant-'));
const run = () => spawnSync(process.execPath, ['--test', TEST], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 600_000, env: { ...process.env, LOCALAPPDATA: local } });
if (run().status !== 0) {
  console.log(`BASELINE RED: ${TEST} fails unmutated, so no mutant proves anything.`);
  process.exit(2);
}

let bad = 0;
for (const [name, file, from, to, dies] of MUTANTS) {
  const abs = path.join(ROOT, file);
  const original = fs.readFileSync(abs, 'utf8');
  const source = original.replace(/\r\n/g, '\n');
  const at = source.indexOf(from);
  if (at < 0 || source.indexOf(from, at + 1) >= 0) {
    console.log(`INERT ${name} (anchor ${at < 0 ? 'missing' : 'not unique'})`);
    bad += 1;
    continue;
  }
  let mutated = source.slice(0, at) + to + source.slice(at + from.length);
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
fs.rmSync(local, { recursive: true, force: true });
process.exitCode = bad ? 1 : 0;
