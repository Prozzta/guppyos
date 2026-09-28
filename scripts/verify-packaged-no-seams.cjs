#!/usr/bin/env node
/*
 * ZT-I1-MAIL 1.1.75 (god 4dd770 decision 1, Jim): the release check that the SHIPPED app has the
 * layer-(b) test seams COMPILED OUT. The seams (MUNDER_HIDDEN, MUNDER_DEV_ROOT) exist only in a
 * bundle built with MUNDER_LAYERB_SEAMS=1 (electron.vite.config.ts __LAYERB_SEAMS__); a release
 * build must never be one.
 *
 *   node scripts/verify-packaged-no-seams.cjs dist/win-unpacked/resources/app.asar
 *
 * Checks the packaged out/main/index.js:
 * - LAYERB_SEAMS_BUILT is the literal false;
 * - neither variable name survives as a string literal (only comments may name them);
 * - DEV_ROOT_ENV and DEV_HIDDEN_ENV are the empty string.
 * Prints SEAMS COMPILED OUT, or SEAMS PRESENT (exit 1).
 */
'use strict';
const path = require('path');

/** The checks on the main bundle's text. Pure. */
function verifyBundleText(text) {
  const problems = [];
  if (!text) return { ok: false, problems: ['empty main bundle'] };
  const m = /const LAYERB_SEAMS_BUILT = ([^;\n]+);/.exec(text);
  if (!m) problems.push('LAYERB_SEAMS_BUILT not found in the main bundle');
  else if (m[1].trim() !== 'false') problems.push(`LAYERB_SEAMS_BUILT = ${m[1].trim()} (must be the literal false)`);
  for (const name of ['MUNDER_HIDDEN', 'MUNDER_DEV_ROOT', 'MUNDER_LAYERB_SEAMS']) {
    if (new RegExp(`["'\`]${name}["'\`]`).test(text)) problems.push(`the string "${name}" is still in the code`);
  }
  for (const k of ['DEV_ROOT_ENV', 'DEV_HIDDEN_ENV']) {
    const d = new RegExp(`const ${k} = ([^;\\n]+);`).exec(text);
    if (!d) problems.push(`${k} not found`);
    else if (!/^(""|'')$/.test(d[1].trim())) problems.push(`${k} = ${d[1].trim()} (must be "")`);
  }
  if (/__LAYERB_SEAMS__/.test(text)) problems.push('the __LAYERB_SEAMS__ define was not substituted');
  return { ok: problems.length === 0, problems };
}

function verify(asarPath) {
  const asar = require('@electron/asar');
  let text = '';
  try { text = asar.extractFile(asarPath, path.join('out', 'main', 'index.js')).toString('utf8'); }
  catch (e) { return { ok: false, problems: [`cannot read out/main/index.js from ${asarPath}: ${e.message}`] }; }
  finally { try { asar.uncache(asarPath); } catch { /* release the handle */ } }
  return verifyBundleText(text);
}

module.exports = { verify, verifyBundleText };

if (require.main === module) {
  const p = process.argv[2];
  if (!p) { console.error('usage: verify-packaged-no-seams.cjs <app.asar>'); process.exit(2); }
  const r = verify(p);
  if (r.ok) { console.log('SEAMS COMPILED OUT'); process.exit(0); }
  for (const x of r.problems) console.error(`  - ${x}`);
  console.error('SEAMS PRESENT');
  process.exit(1);
}
