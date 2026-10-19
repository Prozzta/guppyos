'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

const waitFor = async (predicate, message) => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
};

test('MUTANT RUNNER KILL SAFE: hard-killed runner restores its source before the next run', { timeout: 120_000 }, async () => {
  // This must not share the FULL suite's source tree or recovery journal: the
  // assertion deliberately leaves a killed process' mutation in place briefly.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mutant-runner-kill-safe-'));
  const runner = path.join(sandbox, 'test/tools/agy-mutants.cjs');
  const source = path.join(sandbox, 'src/main/capacityNormalize.ts');
  const journal = path.join(sandbox, '.mutant-runner-recovery.json');
  fs.mkdirSync(path.dirname(runner), { recursive: true });
  fs.mkdirSync(path.dirname(source), { recursive: true });
  for (const rel of ['test/tools/agy-mutants.cjs', 'test/tools/mutant-runner-helper.cjs', 'src/main/capacityNormalize.ts']) {
    fs.copyFileSync(path.join(ROOT, rel), path.join(sandbox, rel));
  }
  const original = fs.readFileSync(source, 'utf8');
  let child;
  try {
    child = spawn(process.execPath, [runner, 'D-1'], {
      cwd: ROOT,
      env: { ...process.env, MUTANT_RUNNER_PAUSE_AFTER_MUTATE_MS: '30000' },
      stdio: 'ignore'
    });
    await waitFor(() => fs.existsSync(journal), 'runner never reached its journaled mutation');
    assert.notEqual(fs.readFileSync(source, 'utf8'), original, 'runner must be paused after the source mutation');
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('close', resolve));
    assert.notEqual(fs.readFileSync(source, 'utf8'), original, 'hard kill leaves recoverable source drift');

    const recovery = spawn(process.execPath, [runner, '--recover-only'], { cwd: ROOT, stdio: 'ignore' });
    await new Promise((resolve) => recovery.once('close', resolve));
    assert.equal(recovery.exitCode, 0, 'next runner start must accept and repair the journal');
    assert.equal(fs.readFileSync(source, 'utf8'), original, 'next runner start restores the exact original bytes');
    assert.equal(fs.existsSync(journal), false, 'successful recovery consumes its journal');
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
