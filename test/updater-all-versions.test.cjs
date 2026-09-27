'use strict';

/**
 * UPDATER-ALL-VERSIONS (1.1.63): the updater offers EVERY newer release, not
 * only the latest.
 *
 * The Human was on 1.1.59 with 1.1.60 and 1.1.61 published and was offered one
 * version. electron-updater resolves `releases/latest` + that tag's latest.yml
 * and returns ONE UpdateInfo, and every surface rendered that one version. Now:
 *   - native path: `fullChangelog = true` makes electron-updater return
 *     `releaseNotes` as [{version, note}] for every release in (current, latest],
 *     from the releases.atom feed it downloads anyway;
 *   - fallback path: `/releases?per_page=30` instead of `/releases/latest`,
 *     still ONE request;
 *   - the status carries `versions` (newest first) and a ReleasePicker in the
 *     badge and in Settings lets the user pick, latest preselected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const { newerReleases, releaseOptionsFromNotes, releaseChoices, optionDownloadUrl, installerUrl, REPO } =
  loadTs('src/shared/updateState.ts');
const { htmlToNoteText, summarizeReleaseNotes } = loadTs('src/shared/releaseNotes.ts');

const rel = (v, extra = {}) => ({
  tag_name: `v${v}`, html_url: `https://github.com/${REPO}/releases/tag/v${v}`,
  body: `## What's new in ${v}\n\n- change in ${v}`, draft: false, prerelease: false,
  assets: [{ name: `Munder-Difflin-${v}-win-x64-setup.exe`, browser_download_url: `https://github.com/${REPO}/releases/download/v${v}/Munder-Difflin-${v}-win-x64-setup.exe` }],
  ...extra
});

test("the Human's case: on 1.1.59 with 1.1.60..1.1.62 published, all three are offered, latest first", () => {
  const list = [rel('1.1.62'), rel('1.1.61'), rel('1.1.60'), rel('1.1.59'), rel('1.1.58')];
  const out = newerReleases(list, '1.1.59', 'win32', 'x64', (a) => a?.[0]?.browser_download_url ?? null);
  assert.deepEqual(out.map((r) => r.version), ['1.1.62', '1.1.61', '1.1.60']);
  assert.match(out[1].notes, /change in 1\.1\.61/);
  assert.match(out[2].downloadUrl, /v1\.1\.60\/Munder-Difflin-1\.1\.60-win-x64-setup\.exe$/);
});

test('newerReleases drops drafts, prereleases, junk tags and duplicates; sorts numerically', () => {
  const list = [
    rel('1.1.9'), rel('1.1.10'), rel('1.1.11', { draft: true }), rel('1.1.12', { prerelease: true }),
    { tag_name: 'nightly' }, null, rel('1.1.10'), rel('1.1.8')
  ];
  const out = newerReleases(list, '1.1.8', 'win32', 'x64');
  assert.deepEqual(out.map((r) => r.version), ['1.1.10', '1.1.9']);
  // No asset picker -> the conventional installer URL for this machine.
  assert.equal(out[0].downloadUrl, installerUrl('1.1.10', 'win32', 'x64'));
  assert.deepEqual(newerReleases({ message: 'rate limited' }, '1.0.0', 'win32', 'x64'), []);
  assert.deepEqual(newerReleases([rel('1.1.8')], '1.1.8', 'win32', 'x64'), []);
});

test('releaseOptionsFromNotes: fullChangelog array -> every newer version, notes converted', () => {
  const notes = [
    { version: '1.1.62', note: '<h2>What&#39;s new in 1.1.62</h2><ul><li>Codex wake &amp; timing</li></ul>' },
    { version: '1.1.61', note: '<ul><li>older fix</li></ul>' },
    { version: '1.1.60', note: null }
  ];
  const out = releaseOptionsFromNotes(notes, '1.1.62', '1.1.59', 'win32', 'x64', htmlToNoteText);
  assert.deepEqual(out.map((r) => r.version), ['1.1.62', '1.1.61', '1.1.60']);
  assert.deepEqual(summarizeReleaseNotes(out[0].notes), ['Codex wake & timing']);
  assert.equal(out[2].notes, undefined);
  assert.equal(out[1].url, `https://github.com/${REPO}/releases/tag/v1.1.61`);
  assert.equal(out[1].downloadUrl, installerUrl('1.1.61', 'win32', 'x64'));
});

test('releaseOptionsFromNotes always includes the latest electron-updater resolved', () => {
  // A plain string (fullChangelog off / older electron-updater): one option.
  assert.deepEqual(releaseOptionsFromNotes('<p>x</p>', '1.2.0', '1.1.0', 'win32', 'x64').map((r) => r.version), ['1.2.0']);
  // Feed lacked the latest entry (atom caps at 10): latest is still offered, first.
  const out = releaseOptionsFromNotes([{ version: '1.1.5', note: 'n' }], '1.2.0', '1.1.0', 'win32', 'x64');
  assert.deepEqual(out.map((r) => r.version), ['1.2.0', '1.1.5']);
  assert.deepEqual(releaseOptionsFromNotes(null, '1.1.0', '1.1.0', 'win32', 'x64'), []);
});

test("real electron-updater computeReleaseNotes(fullChangelog) output feeds the picker", () => {
  const { computeReleaseNotes } = require('electron-updater/out/providers/GitHubProvider');
  const { parseXml } = require('builder-util-runtime');
  const semver = require('semver');
  const entry = (v, html) => `<entry><id>tag:github.com,2008:Repository/1/v${v}</id>` +
    `<link rel="alternate" type="text/html" href="https://github.com/${REPO}/releases/tag/v${v}"/>` +
    `<title>Munder Difflin v${v}</title><content type="html">${html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</content></entry>`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">` +
    entry('1.1.62', "<h2>What's new in 1.1.62</h2><ul><li>Twelve</li></ul>") +
    entry('1.1.61', "<h2>What's new in 1.1.61</h2><ul><li>Eleven</li></ul>") +
    entry('1.1.60', "<h2>What's new in 1.1.60</h2><ul><li>Ten</li></ul>") +
    entry('1.1.59', '<p>current</p>') + '</feed>';
  const feed = parseXml(xml);
  const latest = feed.getElements('entry')[0];
  const notes = computeReleaseNotes(semver.parse('1.1.59'), true, feed, latest);
  const out = releaseOptionsFromNotes(notes, '1.1.62', '1.1.59', 'win32', 'x64', htmlToNoteText);
  assert.deepEqual(out.map((r) => r.version), ['1.1.62', '1.1.61', '1.1.60']);
  assert.deepEqual(out.map((r) => summarizeReleaseNotes(r.notes)[0]), ['Twelve', 'Eleven', 'Ten']);
});

test('releaseChoices: legacy single-version status, many versions, and the status version leads', () => {
  assert.deepEqual(releaseChoices(null, '1.0.0'), []);
  assert.deepEqual(releaseChoices({ state: 'not-available' }, '1.0.0'), []);
  assert.deepEqual(releaseChoices({ state: 'downloaded', version: '1.2.0' }, '1.0.0'), []);
  const one = releaseChoices({ state: 'available', version: '1.2.0', notes: 'n' }, '1.0.0');
  assert.deepEqual(one.map((r) => [r.version, r.notes]), [['1.2.0', 'n']]);
  const many = releaseChoices({
    state: 'available-manual', version: '1.2.0', url: 'u', downloadUrl: 'd',
    versions: [{ version: '1.1.0', url: 'a' }, { version: '1.2.0', url: 'u', downloadUrl: 'd' }, { version: '0.9.0', url: 'old' }]
  }, '1.0.0');
  assert.deepEqual(many.map((r) => r.version), ['1.2.0', '1.1.0']);
  assert.equal(optionDownloadUrl(many[0], 'win32', 'x64'), 'd');
  assert.equal(optionDownloadUrl(many[1], 'win32', 'x64'), installerUrl('1.1.0', 'win32', 'x64'));
});

test('htmlToNoteText: atom HTML -> digestible text; markdown passes through untouched', () => {
  const md = "## What's new\n\n- **bold** `code`";
  assert.equal(htmlToNoteText(md), md);
  assert.equal(htmlToNoteText(undefined), '');
  const t = htmlToNoteText('<h1>Title</h1><p>Lead a &lt; b &#x2014; ok</p><hr><h2>What&#39;s new</h2><ul>\n<li><strong>A</strong> one</li>\n<li>B&nbsp;two</li></ul><!-- drop --><script>bad()</script>');
  assert.match(t, /^# Title\nLead a < b — ok/);
  assert.match(t, /## What's new\n\n- A one\n- B two/);
  assert.doesNotMatch(t, /bad\(\)|<\/?[a-z]|drop/);
  assert.deepEqual(summarizeReleaseNotes(t), ['A one', 'B two']);
});

test('updater.ts: fullChangelog on, one-request fallback list, versions emitted on both paths', () => {
  const src = read('src/main/updater.ts');
  assert.match(src, /autoUpdater\.fullChangelog\s*=\s*true/);
  assert.match(src, /\/releases\?per_page=30/);
  assert.doesNotMatch(src, /path:\s*`\/repos\/\$\{REPO\}\/releases\/latest`/, 'fallback must use the list, not releases/latest');
  // Still exactly one fallback API request builder (release body lookup is the other, by tag).
  assert.equal((src.match(/hostname:\s*'api\.github\.com'/g) ?? []).length, 2);
  assert.match(src, /releaseOptionsFromNotes\(info\.releaseNotes/);
  assert.match(src, /emit\(\{ state: 'available', version: info\.version, notes: noteFor\(info\.releaseNotes, info\.version\), versions \}\)/);
  assert.match(src, /versions\s*\n\s*\}\);/, 'available-manual carries versions');
  // Notify-only ruling still holds.
  assert.match(src, /autoUpdater\.autoDownload\s*=\s*false/);
});

test('the badge and Settings render the ReleasePicker from releaseChoices', () => {
  const badge = read('src/renderer/src/components/UpdateBadge.tsx');
  assert.match(badge, /releaseChoices\(status, __APP_VERSION__\)/);
  assert.match(badge, /choices\.length > 1/);
  assert.match(badge, /<ReleasePicker/);
  assert.match(badge, /optionDownloadUrl\(selected/);
  const settings = read('src/renderer/src/components/UpdatesSection.tsx');
  assert.match(settings, /<ReleasePicker/);
  assert.match(settings, /olderChosen/);
  const picker = read('src/renderer/src/components/ReleasePicker.tsx');
  assert.match(picker, /<select/);
  assert.match(picker, /i === 0 \? ' \(latest\)' : ''/);
  assert.match(picker, /summarizeReleaseNotes\(option\?\.notes\)/);
});

// RENDERED (hidden Electron window, test/electron-harness): the production badge and
// Settings block, fed the Human's case. Launches a real, never-shown Electron process.
test('RENDERED: badge and Settings offer 1.1.62/61/60, latest preselected, and download the one picked', async () => {
  const { runScenario } = require('./electron-harness/run.cjs');
  const r = await runScenario(path.join(__dirname, 'electron-harness', 'scenarios', 'update-picker.tsx'), { timeoutMs: 120_000 });
  assert.equal(r.ok, true, `scenario failed: ${r.error ?? ''}`);
  // A. badge
  assert.equal(r.badge.openedAfterChipClick, 0, 'with 3 choices the chip opens the picker, it does not download');
  assert.deepEqual(r.badge.options, ['v1.1.62 (latest)', 'v1.1.61', 'v1.1.60']);
  assert.equal(r.badge.preselected, '1.1.62');
  assert.match(r.badge.notesLatest, /only in 1\.1\.62/);
  assert.match(r.badge.notesPicked, /only in 1\.1\.60/, 'the notes follow the selection');
  assert.equal(r.badge.dlLabel, 'download v1.1.60');
  assert.deepEqual(r.badge.opened, [`https://github.com/${REPO}/releases/download/v1.1.60/Munder-Difflin-1.1.60-win-x64-setup.exe`]);
  // B. Settings
  assert.equal(r.settings.hasSelect, true);
  assert.equal(r.settings.nativeBtn, 'Download v1.1.62', 'the latest keeps the native download');
  assert.equal(r.settings.downloadsAfterNative, 1);
  assert.equal(r.settings.olderLabel, 'Download v1.1.61 installer');
  assert.match(r.settings.settingsNotes, /only in 1\.1\.61/);
  assert.deepEqual(r.settings.opened, [`https://github.com/${REPO}/releases/download/v1.1.61/Munder-Difflin-1.1.61-win-x64-setup.exe`]);
  assert.equal(r.settings.downloadsAfterOlder, 1, 'an older pick never triggers the native (latest-only) download');
  // C. one newer version: unchanged one-click download
  assert.equal(r.single.hasSelect, false);
  assert.equal(r.single.opened.length, 1);
});
