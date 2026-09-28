'use strict';

/**
 * CHANGELOG-NOT-PACKAGED (1.1.73). main's 'app:info' (the voice get_app_info tool) reads
 * <appPath>/CHANGELOG.md. electron-builder.yml listed CHANGELOG.md BEFORE "!**\/*.{md,...}", and the
 * patterns apply in order, so the exclude removed it again: no packaged build from 0.3.4 to 1.1.72
 * had release notes (the installed 1.1.72 asar: 12068 entries, no CHANGELOG.md).
 *
 * The fix was proven on a real `electron-builder --win --dir` pack of this tree: the asar has
 * /CHANGELOG.md as its ONLY .md, and app:info's reader yields the top sections. Here:
 * - the files: ORDER (the root cause);
 * - the release check (scripts/verify-packaged-changelog.cjs) against asars built the way
 *   electron-builder builds them;
 * - that the check's reader matches main's.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const asar = require('@electron/asar');
const { readSource: read } = require('./read-source.cjs');
const { verify, releaseNotesOf } = require('../scripts/verify-packaged-changelog.cjs');

test('electron-builder.yml: CHANGELOG.md is included AFTER the md exclude (patterns apply in order)', () => {
  const yml = read('electron-builder.yml');
  const files = yml.slice(yml.indexOf('\nfiles:'), yml.indexOf('\nextraResources:'));
  const lines = files.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('- '));
  const exclude = lines.findIndex((l) => l.includes('!**/*.{md'));
  const include = lines.findIndex((l) => l === '- CHANGELOG.md');
  assert.ok(exclude >= 0 && include >= 0, JSON.stringify(lines));
  assert.ok(include > exclude, 'CHANGELOG.md must come after "!**/*.{md,...}" or the exclude removes it');
});

async function pack(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clpack-'));
  // Best-effort: on Windows a freshly written asar can stay locked for a moment (a scanner), and a
  // leftover temp dir is not what this test is about.
  t.after(() => { try { asar.uncacheAll(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* leave it */ } });
  const src = path.join(dir, 'app');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), body);
  }
  const out = path.join(dir, 'app.asar');
  await asar.createPackage(src, out);
  return out;
}

const CL = '# Changelog\r\n\r\n## [Unreleased]\r\n\r\n- next\r\n\r\n## [1.1.73] - 2026-09-28\r\n\r\n- CHANGELOG ships again\r\n';

test('verify: OK when /CHANGELOG.md is the only .md and yields notes', async (t) => {
  const r = verify(await pack(t, { 'package.json': '{}', 'CHANGELOG.md': CL, 'out/main/index.js': '' }));
  assert.deepEqual([r.ok, r.problems, r.mdCount], [true, [], 1]);
});

test('verify: FAILS when CHANGELOG.md is missing (the 0.3.4-1.1.72 packaging)', async (t) => {
  const r = verify(await pack(t, { 'package.json': '{}', 'out/main/index.js': '' }));
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /CHANGELOG\.md is not in the asar/);
});

test('verify: FAILS when it is empty or has no "## " section, and when other .md files leak in', async (t) => {
  assert.match(verify(await pack(t, { 'CHANGELOG.md': ' ' })).problems.join(), /empty/);
  assert.match(verify(await pack(t, { 'CHANGELOG.md': '# Changelog\nnothing yet\n' })).problems.join(), /no "## " section/);
  assert.match(verify(await pack(t, { 'CHANGELOG.md': CL, 'node_modules/x/README.md': 'x' })).problems.join(), /md exclude no longer holds/);
});

test('the check reads release notes exactly as main\'s app:info does', () => {
  const idx = read('src/main/index.ts');
  assert.ok(idx.includes("changelog.split(/\\n## /).slice(1).filter((s) => !/^\\[?unreleased\\]?/i.test(s)).slice(0, 2).map((s) => `## ${s}`).join('\\n').slice(0, 8000)"), 'main reads the two newest RELEASED sections, like the check');
  assert.match(idx, /join\(app\.getAppPath\(\), 'CHANGELOG\.md'\)/, 'main reads it from the asar root');
  const notes = releaseNotesOf(CL + '\r\n## [1.1.72] - 2026-09-28\r\n\r\n- older\r\n\r\n## [1.1.71]\r\n- oldest\r\n');
  assert.ok(notes.startsWith('## [1.1.73]') && notes.includes('## [1.1.72]'), 'the two newest released sections');
  assert.ok(!/Unreleased/.test(notes) && !notes.includes('1.1.71'), '[Unreleased] skipped; only two');
});
