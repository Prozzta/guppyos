'use strict';

/**
 * WIPE (1.1.60): no tracked file names the retired memory CLI, except the CHANGELOG (release
 * history) and, until the Human decides, the public website's published pages.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
/** The retired name, built so this file does not itself contain it. */
const OLD = new RegExp(['mem', 'palace'].join('\\s*'), 'i');

/** Allowed to keep the old name: release history (CHANGELOG.md, and RELEASE.md = the v0.4.5
 *  notes), and the public website (its pages, sources, media and design spec) until the Human
 *  decides on it (god, 2026-09-27; a separate change). */
const ALLOWED = [/^CHANGELOG\.md$/, /^RELEASE\.md$/, /^docs\/media\//, /^docs\/DESIGN\.md$/,/^docs\/blog\//, /^blog\//, /^seo\//, /^landing-remotion\//, /^docs\/index\.html$/, /^docs\/sitemap\.xml$/, /^docs\/r\//];

test('no tracked file names the old CLI, except the CHANGELOG history and the (pending) public site', (t) => {
  let files;
  try { files = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean); } catch { t.skip('not a git checkout'); return; }
  const hits = [];
  for (const f of files) {
    if (ALLOWED.some((re) => re.test(f))) continue;
    if (OLD.test(f)) { hits.push(f); continue; }
    let buf;
    try { buf = fs.readFileSync(path.join(REPO, f)); } catch { continue; }
    if (buf.includes(0)) continue;   // binary
    if (OLD.test(buf.toString('utf8'))) hits.push(f);
  }
  assert.deepEqual(hits, []);
});
