'use strict';
require('./tools/own-job.cjs');
// MUTANT-JOURNAL-GATE (god 5cc045/ed8032): this suite loads a file a census mutates in place (one load-ts never sees);
// refuse a tree a killed census left mutated, before anything is read.
require('./tools/mutant-runner-helper.cjs').gate(__filename);

/**
 * CHANGELOG-HEADINGS-GATE (1.1.99). The 1.1.99 cut commit 2cd1f281 replaced "## [1.1.98] — 2026-10-22"
 * instead of inserting the [1.1.99] section above it: the 1.1.98 notes sat headless under [1.1.99],
 * and every gate of the cut passed it (it was found while extracting the release notes). The fix
 * 96c15ba8 restored the line. scripts/verify-changelog-history.cjs, run at the end of `cut:win`,
 * fails a build whose CHANGELOG drops or edits a released heading, reorders released sections or
 * removes a line from one, against the last release's CHANGELOG.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { removeDir } = require('./tools/test-temp.cjs');
const { readSource: read } = require('./read-source.cjs');
const { releasedSections, checkHistory, readChangelog } = require('../scripts/verify-changelog-history.cjs');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'verify-changelog-history.cjs');
const nl = (s) => s.replace(/\r\n/g, '\n');

const BASE = [
  '# Changelog', '', '## [Unreleased]', '', '- next', '',
  '## [1.1.98] — 2026-10-22', '', '**Mail that arrives.**', 'Rollback: 1.1.97 (reinstall).', '', '### Fixed', '', '- Wakes typed but never sent.', '',
  '## [1.1.97] — 2026-10-19', '', '- Messages typed where the agent can take them.', '',
].join('\r\n');
const NEW = '## [1.1.99] — 2026-10-22\r\n\r\n**The window stays smooth.**\r\n\r\n';
const GOOD = BASE.replace('## [1.1.98]', NEW + '## [1.1.98]');

test('a new section above the released ones passes; [Unreleased] and the preamble are not released', () => {
  assert.deepEqual(releasedSections(BASE).map((s) => s.version), ['1.1.98', '1.1.97']);
  assert.deepEqual(releasedSections(BASE)[0].lines, ['**Mail that arrives.**', 'Rollback: 1.1.97 (reinstall).', '### Fixed', '- Wakes typed but never sent.']);
  assert.deepEqual(checkHistory(BASE, GOOD), { ok: true, problems: [], added: ['1.1.99'] });
  assert.equal(checkHistory(BASE, nl(GOOD)).ok, true, 'line endings do not matter');
  assert.equal(checkHistory(BASE, GOOD.replace('- next', '- next\r\n- later')).ok, true, '[Unreleased] may change');
  assert.equal(checkHistory(BASE, GOOD.replace('- Wakes typed but never sent.', '- Wakes typed but never sent.\r\n- One more fix.')).ok, true, 'a line may be added');
});

test('2cd1f281: the [1.1.98] heading replaced by the new section FAILS (the 1.1.98 notes headless under [1.1.99])', () => {
  const defect = BASE.replace('## [1.1.98] — 2026-10-22\r\n', NEW);
  const r = checkHistory(BASE, defect);
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, ['released heading dropped: "## [1.1.98] — 2026-10-22"']);
});

test('an edited heading, a removed line, a reorder, a new section below a released one and a duplicate each FAIL', () => {
  const one = (text) => { const r = checkHistory(BASE, text); assert.equal(r.ok, false, text); return r.problems.join(' | '); };
  assert.match(one(GOOD.replace('## [1.1.98] — 2026-10-22', '## [1.1.98] — 2026-10-21')), /released heading edited: "## \[1\.1\.98\] — 2026-10-22" is now "## \[1\.1\.98\] — 2026-10-21"/);
  assert.match(one(GOOD.replace('- Wakes typed but never sent.\r\n', '')), /\[1\.1\.98\] lost 1 line\(s\), first: "- Wakes typed but never sent\."/);
  assert.match(one(GOOD.replace('Rollback: 1.1.97 (reinstall).', 'Rollback: 1.1.96 (reinstall).')), /\[1\.1\.98\] lost 1 line/, 'an edited line is a removed one');
  assert.match(one(GOOD.replace('**Mail that arrives.**\r\nRollback: 1.1.97 (reinstall).', 'Rollback: 1.1.97 (reinstall).\r\n**Mail that arrives.**')), /\[1\.1\.98\] lost 1 line/, 'lines keep their order');
  const s98 = GOOD.slice(GOOD.indexOf('## [1.1.98]'), GOOD.indexOf('## [1.1.97]'));
  assert.match(one(GOOD.replace(s98, '') + s98), /released sections out of order: 1\.1\.97, 1\.1\.98/);
  assert.match(one(BASE + '\r\n' + NEW), /new section \[1\.1\.99\] sits below a released one/);
  assert.match(one(GOOD.replace('## [1.1.97]', '## [1.1.98] — 2026-10-22\r\n\r\n- again\r\n\r\n## [1.1.97]')), /\[1\.1\.98\] appears twice/);
  assert.match(one(GOOD.replace('- Messages typed where the agent can take them.\r\n', '')), /\[1\.1\.97\] lost 1 line\(s\), first: "- Messages typed where the agent can take them\."/, 'an older section loses a line too');
  assert.match(one(GOOD.replace(/## \[1\.1\.97\][^]*$/, '')), /released heading dropped: "## \[1\.1\.97\] — 2026-10-19"/, 'a dropped older section');
});

test('a base with no released section is a failure, never a pass', () => {
  const r = checkHistory('# Changelog\n\n## [Unreleased]\n', GOOD);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(), /base CHANGELOG has no released/);
});

test('this tree\'s CHANGELOG: the newest section on top of the rest passes, and its second heading dropped (2cd1f281\'s shape) FAILS', () => {
  const text = nl(read('CHANGELOG.md'));
  const heads = text.split('\n').filter((l) => /^## \[\d+\.\d+\.\d+\]/.test(l));
  assert.ok(heads.length >= 2, 'at least two released sections');
  const base = text.slice(0, text.indexOf(heads[0])) + text.slice(text.indexOf(heads[1]));
  assert.deepEqual(checkHistory(base, text), { ok: true, problems: [], added: [heads[0].match(/\[(.+?)\]/)[1]] });
  const defect = text.replace(heads[1] + '\n', '');
  assert.deepEqual(checkHistory(base, defect).problems, [`released heading dropped: "${heads[1]}"`]);
});

const has = (ref) => spawnSync('git', ['-C', ROOT, 'cat-file', '-e', `${ref}^{commit}`], { windowsHide: true }).status === 0;
const show = (ref) => spawnSync('git', ['-C', ROOT, 'show', `${ref}:CHANGELOG.md`], { encoding: 'utf8', maxBuffer: 64 << 20, windowsHide: true }).stdout;
const REAL = ['e19f41f0f03d2fcec26800956e4e7afd58cd6598', '2cd1f2810130bcfe743bec8e7e245ffcf67bcd46', '96c15ba8826d6356b0f534dd105966c84b98b687'];
test('the real 1.1.99 commits: 2cd1f281 FAILS and 96c15ba8 passes against the 1.1.98 CHANGELOG (INT e19f41f0)',
  { skip: REAL.every(has) ? false : 'the 1.1.99 commits are not in this clone' },
  () => {
    const [base, bad, good] = REAL.map(show);
    assert.deepEqual(checkHistory(base, bad).problems, ['released heading dropped: "## [1.1.98] — 2026-10-22"']);
    assert.deepEqual(checkHistory(base, good), { ok: true, problems: [], added: ['1.1.99'] });
  });

test('the CLI reads an app.asar\'s CHANGELOG, and exits 1 on a dropped heading, 0 when kept, 1 with no base', async (t) => {
  const asar = require('@electron/asar');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clhist-'));
  t.after(async () => { try { asar.uncacheAll(); } catch { /* nothing cached */ } await removeDir(dir); });
  const pack = async (name, changelog) => {
    const src = path.join(dir, name);
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'CHANGELOG.md'), changelog);
    fs.writeFileSync(path.join(src, 'package.json'), '{}');
    await asar.createPackage(src, path.join(dir, `${name}.asar`));
    return path.join(dir, `${name}.asar`);
  };
  // The base is this tree's CHANGELOG at HEAD; the targets are it with and without its second heading.
  const text = nl(read('CHANGELOG.md'));
  const second = text.split('\n').filter((l) => /^## \[\d+\.\d+\.\d+\]/.test(l))[1];
  const kept = await pack('kept', show('HEAD'));
  const dropped = await pack('dropped', show('HEAD').replace(/\r?\n/g, '\n').replace(second + '\n', ''));
  assert.equal(nl(readChangelog(kept)), nl(show('HEAD')));
  const cli = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  const ok = cli(kept, '--base', 'HEAD');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /CHANGELOG HISTORY OK \(base HEAD; new: none\)/);
  const bad = cli(dropped, '--base', 'HEAD');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /released heading dropped/);
  assert.match(bad.stderr, /CHANGELOG HISTORY FAILED \(base HEAD\)/);
  const none = cli(kept, '--base', 'no-such-ref-for-this-test');
  assert.equal(none.status, 1, 'an unreadable base fails');
  assert.match(none.stderr, /cannot read no-such-ref-for-this-test:CHANGELOG\.md/);
  // A target the gate cannot read fails; it never passes with nothing checked.
  const bare = path.join(dir, 'bare');
  fs.mkdirSync(bare);
  fs.writeFileSync(path.join(bare, 'package.json'), '{}');
  await asar.createPackage(bare, path.join(dir, 'bare.asar'));
  for (const target of [path.join(dir, 'missing.asar'), path.join(dir, 'bare.asar')]) {
    const r = cli(target, '--base', 'HEAD');
    assert.equal(r.status, 1, `${path.basename(target)} fails`);
    assert.match(r.stderr, /cannot read the CHANGELOG of /);
    assert.doesNotMatch(r.stdout, /CHANGELOG HISTORY OK/);
  }
});

test('the base is the newest v* tag behind HEAD other than this version\'s; with none, the CLI FAILS', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clbase-'));
  t.after(() => removeDir(dir));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'verify-changelog-history.cjs'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"version":"1.1.99"}');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), BASE);
  const git = (...a) => {
    const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...a], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
  };
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const target = path.join(dir, 'next.md');
  fs.writeFileSync(target, GOOD);
  const cli = () => spawnSync(process.execPath, [path.join(dir, 'scripts', 'verify-changelog-history.cjs'), target], { cwd: dir, encoding: 'utf8', windowsHide: true });
  const none = cli();
  assert.equal(none.status, 1, 'no tag: no base is a failure');
  assert.match(none.stderr, /no base: no v\* tag behind HEAD other than v1\.1\.99/);
  assert.match(none.stderr, /CHANGELOG HISTORY FAILED \(base none\)/);
  git('tag', 'v1.1.98');
  git('commit', '-q', '--allow-empty', '-m', 'cut');
  git('tag', 'v1.1.99');
  const { baseRef } = require('../scripts/verify-changelog-history.cjs');
  assert.equal(baseRef(dir, '1.1.99'), 'v1.1.98', 'a cut at its own tag compares with the release before');
  const ok = cli();
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /CHANGELOG HISTORY OK \(base v1\.1\.98; new: \[1\.1\.99\]\)/);
});

test('wiring: cut:win and dist:win both end with the gate on the built asar, through run(; the checklist names it', () => {
  const cut = nl(read('scripts/cut-cmd-natives.cjs'));
  assert.ok(cut.includes("function gate() {\n  run(process.execPath, [\n    path.join('scripts', 'verify-changelog-history.cjs'),\n    path.join('dist', 'win-unpacked', 'resources', 'app.asar')\n  ]);\n}"),
    'gate() runs the script on the built asar through run(, which exits on a non-zero rc');
  const dist = cut.slice(cut.indexOf("} else if (process.argv.includes('--dist-only')) {"), cut.lastIndexOf('} else {'));
  const full = cut.slice(cut.lastIndexOf('} else {'));
  for (const [name, branch] of [['--dist-only', dist], ['the full cut', full]]) {
    assert.match(branch, /check\(\);\n\s*gate\(\);/, `${name} runs the gate right after the build and the native checks`);
  }
  assert.match(read('docs/release-checklist.md'), /node scripts\/verify-changelog-history\.cjs[^]*CHANGELOG HISTORY OK/);
  assert.match(read('scripts/verify-changelog-history.cjs'), /'--exclude', `v\$\{version\}`/, 'a cut at its own tag compares with the release before');
});
