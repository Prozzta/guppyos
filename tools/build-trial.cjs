'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function trialEnv(base = process.env) {
  return { ...base, GUPPY_TRIAL_BUILD: '1' };
}

function run(command, args, env, spawn = spawnSync) {
  const result = spawn(command, args, { cwd: path.resolve(__dirname, '..'), env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function npmCli(env) {
  const cli = env.npm_execpath;
  if (!cli || path.basename(cli).toLowerCase() !== 'npm-cli.js') {
    throw new Error('Trial packaging must be launched through npm so its Node npm-cli.js path is available');
  }
  return cli;
}

function assertTrialArtifactEntries(entries) {
  const bad = entries
    .filter((entry) => {
      if (entry.name === 'win-unpacked' && entry.isDirectory()) return false;
      if (entry.name === 'builder-debug.yml' && entry.isFile()) return false;
      return !entry.name.includes('Trial') || /setup.*\.exe$/i.test(entry.name) || /^Munder-Difflin-/i.test(entry.name) || /^latest.*\.yml$/i.test(entry.name);
    })
    .map((entry) => entry.name);
  if (bad.length) throw new Error(`Trial packaging refused: non-trial dist artifact(s): ${bad.join(', ')}`);
}

function assertTrialArtifacts(root = path.resolve(__dirname, '..')) {
  const dist = path.join(root, 'dist');
  if (!fs.existsSync(dist)) throw new Error(`Trial packaging refused: dist is missing (${dist})`);
  assertTrialArtifactEntries(fs.readdirSync(dist, { withFileTypes: true }));
}

function buildTrial({ env: baseEnv = process.env, spawn = spawnSync, assertArtifacts = assertTrialArtifacts } = {}) {
  const env = trialEnv(baseEnv);
  // Node 20.12+ refuses spawnSync('npm.cmd', ...) without a shell (EINVAL).
  // Invoke npm's JavaScript CLI through this Node instead: no .cmd launcher,
  // no shell quoting, and the same package-script environment.
  run(process.execPath, [npmCli(env), 'run', 'build'], env, spawn);
  // `extends` merges the release Windows target list, so select the sole trial
  // target on the CLI as well as in its config: never let inherited NSIS build.
  run(process.execPath, [path.resolve(__dirname, '..', 'node_modules', 'electron-builder', 'cli.js'), '--config', 'electron-builder.trial.yml', '--win', 'portable', '--publish', 'never'], env, spawn);
  assertArtifacts();
}

exports.trialEnv = trialEnv;
exports.buildTrial = buildTrial;
exports.npmCli = npmCli;
exports.assertTrialArtifactEntries = assertTrialArtifactEntries;
exports.assertTrialArtifacts = assertTrialArtifacts;

if (require.main === module) buildTrial();
