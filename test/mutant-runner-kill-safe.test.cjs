'use strict';
// MUTANT-JOURNAL-GATE (god 5cc045/ed8032): this suite loads a file a census mutates in place (one load-ts never sees);
// refuse a tree a killed census left mutated, before anything is read.
require('./tools/mutant-runner-helper.cjs').gate(__filename);

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
  for (const rel of ['test/tools/agy-mutants.cjs', 'test/tools/mutant-runner-helper.cjs', 'test/tools/ps-env.cjs', 'test/tools/shared-temp.cjs', 'src/main/capacityNormalize.ts']) {
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
    // The journal is renamed into place before the source is written: wait for both (Jim aba53e).
    await waitFor(() => fs.existsSync(journal) && fs.readFileSync(source, 'utf8') !== original, 'runner never reached its journaled mutation');
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

// Jim d54462 (SHOULD on MKS197): recover() runs at every runner start, so a second runner started
// mid-mutant restored the first one's live mutation and the first reported a false survival. The
// journal now names its owner (pid + process start time) and recovery refuses while it lives.
const HELPER = 'test/tools/mutant-runner-helper.cjs';

function sandboxed(helperText) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mutant-runner-owner-'));
  for (const rel of ['test/tools/agy-mutants.cjs', HELPER, 'test/tools/ps-env.cjs', 'test/tools/shared-temp.cjs', 'src/main/capacityNormalize.ts']) {
    fs.mkdirSync(path.dirname(path.join(sandbox, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(sandbox, rel));
  }
  if (helperText !== undefined) fs.writeFileSync(path.join(sandbox, HELPER), helperText);
  return {
    sandbox,
    runner: path.join(sandbox, 'test/tools/agy-mutants.cjs'),
    source: path.join(sandbox, 'src/main/capacityNormalize.ts'),
    journal: path.join(sandbox, '.mutant-runner-recovery.json')
  };
}

function recoverOnly(runner, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runner, '--recover-only'], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.once('close', (code) => resolve({ code, stderr }));
  });
}

const K = {
  async liveOwner(helperText) {
    const sb = sandboxed(helperText);
    const original = fs.readFileSync(sb.source, 'utf8');
    let child;
    try {
      child = spawn(process.execPath, [sb.runner, 'D-1'], {
        cwd: ROOT, env: { ...process.env, MUTANT_RUNNER_PAUSE_AFTER_MUTATE_MS: '60000' }, stdio: 'ignore'
      });
      await waitFor(() => fs.existsSync(sb.journal) && fs.readFileSync(sb.source, 'utf8') !== original, 'runner never reached its journaled mutation');
      const mutant = fs.readFileSync(sb.source, 'utf8');
      assert.equal(JSON.parse(fs.readFileSync(sb.journal, 'utf8')).owner.pid, child.pid, 'the journal names its owner');

      const second = await recoverOnly(sb.runner);
      assert.notEqual(second.code, 0, 'A LIVE OWNER\'S JOURNAL IS NOT RECOVERED: a second runner start refuses');
      assert.match(second.stderr, new RegExp(`pid ${child.pid}\\b`), 'the refusal names the owner pid');
      assert.equal(fs.readFileSync(sb.source, 'utf8'), mutant, 'the live mutant bytes are untouched');
      assert.ok(fs.existsSync(sb.journal), 'the live owner keeps its journal');

      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('close', resolve));
      const third = await recoverOnly(sb.runner);
      assert.equal(third.code, 0, 'A DEAD OWNER\'S JOURNAL IS RECOVERED');
      assert.equal(fs.readFileSync(sb.source, 'utf8'), original, 'the dead owner\'s source is restored byte for byte');
      assert.equal(fs.existsSync(sb.journal), false, 'recovery consumes the journal');
    } finally {
      if (child && child.exitCode === null) child.kill('SIGKILL');
      fs.rmSync(sb.sandbox, { recursive: true, force: true });
    }
  },
  // A live process that reused the owner's pid (this test process, with another start time), and a
  // journal from before the guard (a bare array, no owner): both are crashes, so both recover.
  async reusedPid(helperText) {
    const sb = sandboxed(helperText);
    const original = fs.readFileSync(sb.source, 'utf8');
    const record = { file: sb.source, original: Buffer.from(original, 'utf8').toString('base64') };
    try {
      for (const [label, journal] of [
        ['A REUSED PID IS NOT THE OWNER', { owner: { pid: process.pid, start: '2000-01-01T00:00:00.0000000Z' }, records: [record] }],
        ['A JOURNAL WITHOUT AN OWNER IS RECOVERED', [record]]
      ]) {
        fs.writeFileSync(sb.source, `${original}\n// mutant\n`);
        fs.writeFileSync(sb.journal, JSON.stringify(journal));
        const r = await recoverOnly(sb.runner);
        assert.equal(r.code, 0, `${label}: ${r.stderr}`);
        assert.equal(fs.readFileSync(sb.source, 'utf8'), original, `${label}: restored`);
        assert.equal(fs.existsSync(sb.journal), false, `${label}: journal consumed`);
      }
    } finally {
      fs.rmSync(sb.sandbox, { recursive: true, force: true });
    }
  },
  // Jim 31ba45: a live owner whose start time cannot be read right now (powershell failed or timed out)
  // might still be mutating, so recovery fails closed.
  async unreadableStart(helperText) {
    const sb = sandboxed(helperText);
    const original = fs.readFileSync(sb.source, 'utf8');
    const mutant = `${original}\n// mutant\n`;
    try {
      fs.writeFileSync(sb.source, mutant);
      fs.writeFileSync(sb.journal, JSON.stringify({ owner: { pid: process.pid, start: 'whatever-it-was' },
        records: [{ file: sb.source, original: Buffer.from(original, 'utf8').toString('base64') }] }));
      const r = await recoverOnly(sb.runner, { MUTANT_RUNNER_UNREADABLE_START_PID: String(process.pid) });
      assert.notEqual(r.code, 0, 'A LIVE PID WITH AN UNREADABLE START FAILS CLOSED');
      assert.match(r.stderr, new RegExp(`pid ${process.pid}\\b`), 'the refusal names the pid');
      assert.equal(fs.readFileSync(sb.source, 'utf8'), mutant, 'the mutant bytes are untouched');
      assert.ok(fs.existsSync(sb.journal), 'the journal is kept');
    } finally {
      fs.rmSync(sb.sandbox, { recursive: true, force: true });
    }
  }
};

test('MUTANT RUNNER OWNER: a live owner refuses recovery and keeps its mutant; a dead one recovers', { timeout: 180_000 }, () => K.liveOwner());
test('MUTANT RUNNER OWNER: a reused pid (start time differs) and an ownerless journal recover', { timeout: 120_000 }, () => K.reusedPid());
test('MUTANT RUNNER OWNER: a live pid whose start time cannot be read fails closed', { timeout: 120_000 }, () => K.unreadableStart());

test('MUTANT RUNNER OWNER: MUTANT CENSUS', { timeout: 400_000 }, async () => {
  const helper = fs.readFileSync(path.join(ROOT, HELPER), 'utf8');
  const mutants = [
    ['the liveness check is dropped', 'if (records.length && ownerLive(owner)) {', 'if (false) {', 'liveOwner', /A LIVE OWNER'S JOURNAL IS NOT RECOVERED/],
    ['the pid alone decides (no start time)', 'return start === null || start === owner.start;', 'return true;', 'reusedPid', /A REUSED PID IS NOT THE OWNER/],
    ['an unreadable start fails open (Jim 31ba45)', 'return start === null || start === owner.start;', 'return start !== null && start === owner.start;', 'unreadableStart', /A LIVE PID WITH AN UNREADABLE START FAILS CLOSED/]
  ];
  for (const [name, from, to, killer, dies] of mutants) {
    assert.equal(helper.split(from).length, 2, `anchor for "${name}" is unique`);
    await assert.rejects(() => K[killer](helper.replace(from, to)), dies, `mutant "${name}" must fail ${killer}`);
  }
});
