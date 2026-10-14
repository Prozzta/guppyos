'use strict';

const { spawnSync } = require('node:child_process');
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

function buildTrial({ env: baseEnv = process.env, spawn = spawnSync } = {}) {
  const env = trialEnv(baseEnv);
  // Node 20.12+ refuses spawnSync('npm.cmd', ...) without a shell (EINVAL).
  // Invoke npm's JavaScript CLI through this Node instead: no .cmd launcher,
  // no shell quoting, and the same package-script environment.
  run(process.execPath, [npmCli(env), 'run', 'build'], env, spawn);
  // `extends` merges the release Windows target list, so select the sole trial
  // target on the CLI as well as in its config: never let inherited NSIS build.
  run(process.execPath, [path.resolve(__dirname, '..', 'node_modules', 'electron-builder', 'cli.js'), '--config', 'electron-builder.trial.yml', '--win', 'portable', '--publish', 'never'], env, spawn);
}

exports.trialEnv = trialEnv;
exports.buildTrial = buildTrial;
exports.npmCli = npmCli;

if (require.main === module) buildTrial();
