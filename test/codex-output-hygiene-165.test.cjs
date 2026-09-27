'use strict';
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
