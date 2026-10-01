'use strict';

/**
 * CODEX-TIMER-CALL (1.1.77): an unauthenticated Codex can spend two 30-second
 * curated-plugin sync retries before calling the public export archive. Hive
 * agents neither use those plugins nor may make that background call, so the
 * spawn argv overrides the feature in every fresh and resumed process.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-timer-call-'));
test.after(() => fs.rmSync(JAIL, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

async function pluginFlagKiller(t, Manager) {
  const home = fs.mkdtempSync(path.join(JAIL, 'home-'));
  const priorHome = process.env.HOME;
  const priorProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = priorProfile;
  });
  assert.equal(os.homedir(), home, 'HOME redirect failed before creating a hive');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{"token":"test"}');
  const hive = new Manager(() => path.join(home, 'hive'));
  t.after(() => hive.dispose());
  const injection = await hive.ensureAgent({ id: 'timer', name: 'Timer', provider: 'codex', cwd: home }, {});
  const flag = injection.args.indexOf('features.plugins=false');
  assert.ok(flag > 0, 'CODEX-TIMER-CALL: every Codex spawn must disable curated plugins');
  assert.deepEqual(injection.args.slice(flag - 1, flag + 1), ['-c', 'features.plugins=false'], 'CODEX-TIMER-CALL: the override must be a global Codex config pair');
  assert.equal(injection.args.filter((arg) => arg === 'features.plugins=false').length, 1, 'CODEX-TIMER-CALL: exactly one plugin override is forwarded');
}

test('CODEX-TIMER-CALL: Codex spawn argv disables curated plugins', async (t) => {
  await pluginFlagKiller(t, HiveManager);
});

test('MUTANT CENSUS CODEX-TIMER-CALL: dropped plugin override dies at the spawn argv guarantee', async (t) => {
  const source = readSource('src/main/hive.ts');
  const from = "preArgs.push('-c', 'features.plugins=false');";
  assert.equal(source.split(from).length - 1, 1, 'the mutant edit applies exactly once');
  const file = path.join(__dirname, '..', 'src', 'main', '.codex-timer-call-mutant.ts');
  fs.writeFileSync(file, source.replace(from, '/* mutant: drop plugin override */'), 'utf8');
  try {
    const { HiveManager: Mutant } = loadTs(path.relative(path.resolve(__dirname, '..'), file));
    let died = null;
    try { await pluginFlagKiller(t, Mutant); } catch (e) { died = e; }
    assert.ok(died instanceof assert.AssertionError, 'SURVIVED: CODEX-TIMER-CALL dropped plugin override');
    assert.match(died.message, /CODEX-TIMER-CALL/, 'the mutant died at the wrong guarantee');
  } finally {
    fs.rmSync(file, { force: true });
  }
});
