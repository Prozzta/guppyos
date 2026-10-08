'use strict';
/**
 * CLAIM-LEDGER F5 as a C4 drill case: this build's ledger store under Electron as Node (the drill
 * runner, sandbox hive, jailed home): a torn rekey line records no new key id, and the retry heals
 * every agent. It fails (never skips) when Electron is missing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-f5-drill-'));
test.after(() => fs.rmSync(JAIL, { recursive: true, force: true }));
const { runDrill } = require('./claims-drill/runner.cjs');

test('F5 drill: a torn rekey keeps the old key record (all key-missing); the retry heals all, nothing acked lost, no forgery alert', { timeout: 5 * 60_000 }, async () => {
  const hive = path.join(JAIL, 'hive');
  fs.mkdirSync(path.join(hive, 'agents'), { recursive: true });
  const res = await runDrill({ tree: path.join(__dirname, '..'), hive, home: path.join(JAIL, 'home'), script: path.join(__dirname, 'claims-drill', 'f5-rekey.cjs'), needModel: false });
  assert.equal(res.ok, true, JSON.stringify(res, null, 2));
  assert.deepEqual(res.checks, { harnessStarted: true, homeJailed: true, modelLoaded: false });
  assert.deepEqual(res.midReasons, { andy: 'key-missing', dwight: 'key-missing', creed: 'key-missing' });
  assert.deepEqual(res.after, { andy: 'ok', dwight: 'ok', creed: 'ok' });
  assert.equal(res.forgeryAlerts, 0);
});
