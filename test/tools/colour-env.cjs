'use strict';
/**
 * RUNNER-NOCOLOR-FORCECOLOR-STDERR: the suite owns its colour environment.
 *
 * Node writes "Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set." to
 * stderr when FORCE_COLOR meets NO_COLOR (or NODE_DISABLE_COLORS). Guppy gives every agent terminal
 * FORCE_COLOR=1 (src/main/ptyEnv.ts), so a caller whose shell also had NO_COLOR made every node
 * child of a test print that line, and tests that expect an empty stderr failed: 15 on the Electron
 * leg (its Node 24 warns when a process starts; Node 26 warns when a process first asks about
 * colour). The result of a run depended on the caller's shell.
 *
 * scrubColourEnv(env) deletes the three names from `env` IN PLACE (so it works on process.env) and
 * returns it. Names are matched without regard to letter case: on Windows a variable set as
 * `no_color` is the same variable to a child. With none of the three set no pair can form, also
 * when `node --test` adds FORCE_COLOR for its files itself.
 *
 * Applied in two places, each with a pin of its own (test/colour-env.test.cjs):
 *  - test/tools/own-job.cjs, on load: the first statement of every test file, so a child that a
 *    test starts with no env option inherits a clean env however the file was started;
 *  - test/tools/run-tests.cjs, on the env it hands to `node --test`.
 */
const COLOUR_KEYS = ['FORCE_COLOR', 'NO_COLOR', 'NODE_DISABLE_COLORS'];

function scrubColourEnv(env) {
  for (const k of Object.keys(env)) if (COLOUR_KEYS.includes(k.toUpperCase())) delete env[k];
  return env;
}

module.exports = { scrubColourEnv, COLOUR_KEYS };
