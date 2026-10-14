'use strict';

/**
 * RENDERED: both identity dialogs use the active pack's builder, never leak an
 * Office portrait/name into TES, and preserve an Edit agent's stored fallback.
 * The two source-override runs are a mutant census for Jim's audit findings.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runScenario, harnessTestTimeout } = require('./electron-harness/run.cjs');

const ROOT = path.join(__dirname, '..');
const SCENARIO = path.join(__dirname, 'electron-harness', 'scenarios', 'add-agent-theme-shot.tsx');
const TES = path.join(ROOT, 'themes', 'tes');
const EDIT = path.join(ROOT, 'src', 'renderer', 'src', 'components', 'EditAgentModal.tsx');
const runs = new Map();

function run(key, mutation) {
  if (!runs.has(key)) {
    let directory;
    const overrides = {};
    if (mutation) {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'add-agent-tes-only-'));
      const source = fs.readFileSync(EDIT, 'utf8').replace(/\r\n/g, '\n');
      assert.ok(source.includes(mutation.from), `${key} mutation target exists`);
      const copy = path.join(directory, path.basename(EDIT));
      fs.writeFileSync(copy, source.replace(mutation.from, mutation.to));
      overrides[EDIT] = copy;
    }
    runs.set(key, runScenario(SCENARIO, {
      timeoutMs: 120_000,
      env: {
        HARNESS_THEME_PACKS: JSON.stringify([{ dir: 'tes', from: TES }]),
        ...(mutation ? { HARNESS_SOURCE_OVERRIDES: JSON.stringify(overrides) } : {})
      }
    }).finally(() => {
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
    }));
  }
  return runs.get(key);
}

test('RENDERED: Add and Edit render the pack look only in TES, with the Color row', { timeout: harnessTestTimeout(120_000) }, async () => {
  const result = await run('built');
  assert.equal(result.ok, true, result.error);
  for (const dialog of ['add', 'edit']) {
    const office = result[`${dialog}-office`].census;
    const tes = result[`${dialog}-tes`].census;
    assert.ok(office.officeNames.length > 0 && office.officePortraits > 0, `${dialog}: Office remains unchanged`);
    assert.deepEqual(tes.officeNames, [], `${dialog}: TES has no Office name, including input values`);
    assert.equal(tes.officePortraits, 0, `${dialog}: TES has no Office portrait`);
    assert.equal(tes.officePortraitButtons, 0, `${dialog}: TES has no Office cast picker`);
    assert.equal(tes.lookBuilder, true, `${dialog}: TES has the pack builder`);
    assert.equal(tes.colorRow, true, `${dialog}: the styled Color row renders`);
  }
  assert.ok(result['edit-tes'].census.inputValues.includes('Speck'), 'Edit retains its stored name');
});

test('MUTANT: an extra Office SpritePortrait after Edit’s builder fails the TES census', { timeout: harnessTestTimeout(120_000) }, async () => {
  const result = await run('office-portrait', {
    from: '              <Row label="Color">',
    to: '              <SpritePortrait character={character} />\n\n              <Row label="Color">'
  });
  assert.equal(result.ok, false, 'the injected Office portrait must not pass');
  assert.match(result.error, /edit TES still exposes Office identity/i);
});

test('MUTANT: an Edit effect that resets the saved name to Jim fails the TES census', { timeout: harnessTestTimeout(120_000) }, async () => {
  const result = await run('name-reset', {
    from: '    setName(agent.name);',
    to: "    setName('Jim');"
  });
  assert.equal(result.ok, false, 'the injected name reset must not pass');
  assert.match(result.error, /edit TES still exposes Office identity/i);
  assert.match(result.error, /inputValues.*"Jim"/, 'the census reads the name input value');
});
