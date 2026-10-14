'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

function trialEnv(base = process.env) {
  return { ...base, GUPPY_TRIAL_BUILD: '1' };
}

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: path.resolve(__dirname, '..'), env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function buildTrial() {
  const env = trialEnv();
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  run(npm, ['run', 'build'], env);
  run(process.execPath, [path.resolve(__dirname, '..', 'node_modules', 'electron-builder', 'cli.js'), '--config', 'electron-builder.trial.yml'], env);
}

exports.trialEnv = trialEnv;
exports.buildTrial = buildTrial;

if (require.main === module) buildTrial();
