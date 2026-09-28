#!/usr/bin/env node
/*
 * CHANGELOG-NOT-PACKAGED (1.1.73): the release check that the PACKAGED app carries CHANGELOG.md
 * where main's 'app:info' (the voice get_app_info tool) reads it: <appPath>/CHANGELOG.md, i.e. the
 * root of app.asar. It never shipped from 0.3.4 to 1.1.72: electron-builder.yml listed it BEFORE
 * the "!**\/*.md" exclude, which then removed it.
 *
 *   node scripts/verify-packaged-changelog.cjs dist/win-unpacked/resources/app.asar
 *
 * Checks:
 * - /CHANGELOG.md is in the asar and non-empty;
 * - it yields release notes exactly as 'app:info' reads them (the first "## " sections);
 * - the md exclude still works (it is the ONLY .md in the asar).
 * Prints CHANGELOG PACKAGED OK, or CHANGELOG PACKAGING FAILED (exit 1).
 */
'use strict';
const asar = require('@electron/asar');

/** What main's 'app:info' returns as `changelog` for this text (index.ts, keep in step). */
function releaseNotesOf(text) {
  return text ? text.split(/\n## /).slice(1, 3).map((s) => `## ${s}`).join('\n').slice(0, 8000) : '';
}

function verify(asarPath) {
  const problems = [];
  let entries = [];
  try { entries = asar.listPackage(asarPath); } catch (e) { return { ok: false, problems: [`cannot read ${asarPath}: ${e.message}`] }; }
  const norm = entries.map((e) => e.replace(/\\/g, '/'));
  const md = norm.filter((e) => /\.md$/i.test(e));
  if (!norm.includes('/CHANGELOG.md')) problems.push('/CHANGELOG.md is not in the asar (check the files: order in electron-builder.yml)');
  else {
    let text = '';
    try { text = asar.extractFile(asarPath, 'CHANGELOG.md').toString('utf8'); } catch (e) { problems.push(`cannot extract CHANGELOG.md: ${e.message}`); }
    if (!text.trim()) problems.push('CHANGELOG.md is empty');
    else if (!releaseNotesOf(text)) problems.push('CHANGELOG.md has no "## " section, so app:info would return no notes');
  }
  const others = md.filter((e) => e !== '/CHANGELOG.md');
  if (others.length) problems.push(`the md exclude no longer holds: ${others.length} other .md file(s), e.g. ${others.slice(0, 3).join(', ')}`);
  try { asar.uncache(asarPath); } catch { /* release the archive handle */ }
  return { ok: problems.length === 0, problems, mdCount: md.length };
}

module.exports = { verify, releaseNotesOf };

if (require.main === module) {
  const p = process.argv[2];
  if (!p) { console.error('usage: verify-packaged-changelog.cjs <app.asar>'); process.exit(2); }
  const r = verify(p);
  if (r.ok) { console.log('CHANGELOG PACKAGED OK'); process.exit(0); }
  for (const x of r.problems) console.error(`  - ${x}`);
  console.error('CHANGELOG PACKAGING FAILED');
  process.exit(1);
}
