'use strict';
/**
 * CLAIM-LEDGER C4: the drill runner's guards, without starting Electron. It refuses the live hive
 * and the real home, fails (never skips) on a tree without Electron or the model, and its child
 * env is an allow-list that no hive variable can leak through.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-drill-runner-'));
test.after(() => fs.rmSync(JAIL, { recursive: true, force: true }));
const { runDrill, drillEnv, treeProblem } = require('./claims-drill/runner.cjs');

const script = path.join(JAIL, 's.cjs');
fs.writeFileSync(script, 'module.exports = async () => ({})\n');
const hive = path.join(JAIL, 'hive');
fs.mkdirSync(hive, { recursive: true });

test('the live hive and the real home are refused', async () => {
  for (const live of ['C:\\Dunder\\hive', 'C:\\Dunder\\hive\\agents\\x']) {
    const r = await runDrill({ tree: JAIL, hive: live, home: path.join(JAIL, 'h1'), script });
    assert.equal(r.ok, false); assert.match(r.reason, /live hive/);
  }
  const r = await runDrill({ tree: JAIL, hive, home: os.homedir(), script });
  assert.equal(r.ok, false); assert.match(r.reason, /real home/);
});

test('a tree without Electron or the model FAILS with the reason (never a skip)', async () => {
  const tree = path.join(JAIL, 'tree');
  fs.mkdirSync(tree, { recursive: true });
  fs.writeFileSync(path.join(tree, 'package.json'), '{}');
  const r = await runDrill({ tree, hive, home: path.join(JAIL, 'h2'), script });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^missing electron/);
  assert.match(treeProblem(path.join(JAIL, 'nothing')), /^missing tree/);
  const out = JSON.parse(fs.readFileSync(path.join(JAIL, 'h2', 'drill-result.json'), 'utf8'));
  assert.equal(out.ok, false, 'the result file says so too');
});

test('the child env is an allow-list: no hive, agent, memory or Claude variable; PATH without hive dirs', () => {
  const parent = {
    PATH: ['C:\\Windows\\system32', 'C:\\Dunder\\hive\\bin', 'C:\\Dunder\\hive\\agents\\andy\\bin', 'C:\\tools'].join(path.delimiter),
    SystemRoot: 'C:\\Windows', HIVE_ROOT: 'C:\\Dunder\\hive', AGENT_ID: 'andy', MEMORY_TOKEN: 'x', MUNDER_MEMORY_URL: 'u',
    CLAUDE_CODE_ENTRYPOINT: 'cli', ANTHROPIC_API_KEY: 'secret', HOME: 'C:\\Users\\real', APPDATA: 'C:\\Users\\real\\AppData\\Roaming',
  };
  const home = path.join(JAIL, 'h3');
  const env = drillEnv(home, parent);
  assert.deepEqual(Object.keys(env).sort(), ['APPDATA', 'ELECTRON_RUN_AS_NODE', 'HOME', 'LOCALAPPDATA', 'PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE'].sort());
  assert.equal(env.HOME, home); assert.equal(env.USERPROFILE, home);
  assert.ok(env.APPDATA.startsWith(home) && env.LOCALAPPDATA.startsWith(home) && env.TEMP.startsWith(home));
  assert.equal(env.PATH, ['C:\\Windows\\system32', 'C:\\tools'].join(path.delimiter));
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
});
