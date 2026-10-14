'use strict';

/**
 * Fail closed before electron-builder packs anything. `dist:trial` is the only
 * command that sets the build define, but this hook also proves that the main
 * bundle contains its compiled true value rather than trusting its caller.
 */
const fs = require('node:fs');
const path = require('node:path');

function mainBundle(projectDir) {
  const file = path.join(projectDir, 'out', 'main', 'index.js');
  if (!fs.existsSync(file)) throw new Error(`Trial packaging refused: main bundle is missing (${file})`);
  return file;
}

function assertTrialBundle(projectDir) {
  const file = mainBundle(projectDir);
  const source = fs.readFileSync(file, 'utf8');
  // electron-vite substitutes the define before this hook. Keep both accepted
  // shapes: esbuild may retain the typeof expression or fold it to true.
  const forceDev = /\bFORCE_DEV_BUILD\s*=\s*(?:true|typeof\s+true\s*!==\s*['"]undefined['"]\s*&&\s*true\s*===\s*true)\b/.test(source);
  if (!forceDev || source.includes('__FORCE_DEV__')) {
    throw new Error('Trial packaging refused: main bundle does not prove __FORCE_DEV__ compiled true');
  }
  if (!source.includes('GuppyTrialData')) {
    throw new Error('Trial packaging refused: main bundle lacks the fixed GuppyTrialData root');
  }
}

exports.assertTrialBundle = assertTrialBundle;
exports.default = function assertTrialBundleBeforePack(context) {
  return assertTrialBundle(context.packager.info.projectDir);
};
