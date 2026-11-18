'use strict';
/**
 * TEST-EXECPATH-ENV-108: the env for a child that runs process.execPath AS NODE.
 *
 * Under the Electron leg (ELECTRON_RUN_AS_NODE=1 electron.exe --test ...) process.execPath is
 * electron.exe. A child spawned with an env that lacks ELECTRON_RUN_AS_NODE starts a REAL
 * Electron app (drill-tree-183: an allowlisted env dropped the key and an app came up). Every
 * spawn of process.execPath whose env is not process.env itself goes through nodeEnv().
 *
 * nodeEnv(env) returns a COPY of env (process.env when env is null or undefined). When this process is Electron
 * (process.versions.electron is set) the copy carries ELECTRON_RUN_AS_NODE=1; under plain node
 * nothing is added, so a node run's child env is byte-for-byte what the caller built.
 *
 * Intentional electron.exe launches (a real app on purpose) never use this helper: they spawn
 * the electron binary by its own path and delete the key deliberately.
 *
 * test/execpath-env-guard.test.cjs fails the suite when a spawn of process.execPath passes an
 * env that is not visibly process.env-derived or nodeEnv()-wrapped.
 */
const KEY = 'ELECTRON_RUN_AS_NODE';

function nodeEnv(env, versions = process.versions) {
  // null as well as undefined means process.env: { ...null } would be {} and drop PATH and the rest.
  const out = { ...(env ?? process.env) };
  if (versions && versions.electron) out[KEY] = '1';
  return out;
}

module.exports = { nodeEnv, KEY };
