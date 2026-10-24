'use strict';
require('./tools/own-job.cjs');
/**
 * CODEX-BLOAT-165 fix 7: a Codex agent's developer_instructions carry an output-hygiene rule
 * (no whole files or CSVs; ranges, matches, capped output; big edits via files). Other providers'
 * prompts are unchanged by it.
 *
 * HOME IS REDIRECTED AND ASSERTED before any hive is built.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const toml = require('toml');
const loadTs = require('./load-ts.cjs');

const { HiveManager, CODEX_OUTPUT_HYGIENE_LINE } = loadTs('src/main/hive.ts');

function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb165-hyg-'));
  const realHome = process.env.HOME; const realProfile = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
  });
  assert.equal(os.homedir(), home, 'HOME redirect failed - aborting before constructing any hive');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{"x":1}');
  const hive = new HiveManager(() => path.join(home, 'harness'));
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  return { home, hive };
}

test('the rule says: no whole files/CSVs, ranges and matches, capped output, big edits via files; ASCII and volatile-free', () => {
  assert.match(CODEX_OUTPUT_HYGIENE_LINE, /never print a whole file, log or CSV/);
  assert.match(CODEX_OUTPUT_HYGIENE_LINE, /head\/tail/);
  assert.match(CODEX_OUTPUT_HYGIENE_LINE, /rg, Select-String/);
  assert.match(CODEX_OUTPUT_HYGIENE_LINE, /Select-Object -First 50/);
  assert.match(CODEX_OUTPUT_HYGIENE_LINE, /Write large results to a file/);
  assert.match(CODEX_OUTPUT_HYGIENE_LINE, /small apply_patch hunks or by writing a file/);
  assert.match(CODEX_OUTPUT_HYGIENE_LINE, /^[\x20-\x7e]+$/);
  assert.doesNotMatch(CODEX_OUTPUT_HYGIENE_LINE, /\d{4}-\d{2}-\d{2}/);
});

test('a Codex agent gets it in its developer_instructions', async (t) => {
  const s = sandbox(t);
  const inj = await s.hive.ensureAgent({ id: 'dw-1', name: 'Dwight', provider: 'codex', cwd: s.home });
  const cfg = toml.parse(fs.readFileSync(path.join(inj.env.CODEX_HOME, 'config.toml'), 'utf8'));
  assert.ok(cfg.developer_instructions.includes(CODEX_OUTPUT_HYGIENE_LINE));
});

test('a Claude agent does not (its prompt is unchanged by fix 7)', async (t) => {
  const s = sandbox(t);
  const inj = await s.hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: s.home });
  const prompt = inj.args[inj.args.indexOf('--append-system-prompt') + 1];
  assert.ok(!prompt.includes('OUTPUT HYGIENE'));
});

// DWIGHT-LONG-RUN-KILLED: the exec-cap facts ride in the same developer_instructions.
const { CODEX_EXEC_CAP_LINE } = loadTs('src/main/hive.ts');

test('the exec-cap line says: ~30 s cap, empty output is not death, poll by session_id, no 30 s sleeps, no second run; ASCII and volatile-free', () => {
  assert.match(CODEX_EXEC_CAP_LINE, /returns after about 30 seconds, whatever yield_time_ms you pass/);
  assert.match(CODEX_EXEC_CAP_LINE, /output can be EMPTY/);
  assert.match(CODEX_EXEC_CAP_LINE, /the command did NOT die/);
  assert.match(CODEX_EXEC_CAP_LINE, /write_stdin\(\{session_id, chars: ""\}\)/);
  assert.match(CODEX_EXEC_CAP_LINE, /Never check with a command that sleeps 30 seconds or more/);
  assert.match(CODEX_EXEC_CAP_LINE, /Report exit_code or session_id/);
  assert.match(CODEX_EXEC_CAP_LINE, /Never start a second copy of a run that may still be alive/);
  assert.match(CODEX_EXEC_CAP_LINE, /^[\x20-\x7e]+$/);
  assert.doesNotMatch(CODEX_EXEC_CAP_LINE, /\d{4}-\d{2}-\d{2}/);
});

test('a Codex agent gets the exec-cap line in its developer_instructions; a Claude agent does not', async (t) => {
  const s = sandbox(t);
  const inj = await s.hive.ensureAgent({ id: 'dw-2', name: 'Dwight', provider: 'codex', cwd: s.home });
  const cfg = toml.parse(fs.readFileSync(path.join(inj.env.CODEX_HOME, 'config.toml'), 'utf8'));
  assert.ok(cfg.developer_instructions.includes(CODEX_EXEC_CAP_LINE));
  const c = await s.hive.ensureAgent({ id: 'jim-2', name: 'Jim', provider: 'claude', cwd: s.home });
  const prompt = c.args[c.args.indexOf('--append-system-prompt') + 1];
  assert.ok(!prompt.includes('LONG COMMANDS:'));
});
