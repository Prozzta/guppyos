#!/usr/bin/env node
/*
 * CHANGELOG-HEADINGS-GATE (1.1.99): a cut's CHANGELOG keeps every released section of the last
 * release. The 1.1.99 cut commit 2cd1f281 replaced the line "## [1.1.98] — 2026-10-22" instead of
 * inserting the [1.1.99] section above it, so the 1.1.98 notes sat headless under [1.1.99]; the
 * packaged-changelog check (only "is there a section") and every other gate passed it.
 *
 *   node scripts/verify-changelog-history.cjs <app.asar | CHANGELOG.md> [--base <git ref>]
 *
 * The base is the CHANGELOG of the last release: `git show <ref>:CHANGELOG.md`, where <ref> is the
 * newest v* tag behind HEAD other than v<package version> (a cut at its own tag still compares
 * with the release before). No base found is a failure, never a pass.
 * Checks, against every released "## [x.y.z]" section of the base:
 * - its heading line is still there, unchanged;
 * - the released sections keep the base's order, and new sections only go above them;
 * - none of its non-blank lines is gone (lines may be added, never removed).
 * Prints CHANGELOG HISTORY OK, or CHANGELOG HISTORY FAILED (exit 1).
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RELEASED_RE = /^## \[(\d+\.\d+\.\d+)\]/;

/** The released sections of a CHANGELOG, in file order: { version, heading, lines }. [Unreleased]
 *  and the preamble are not released, so they are not part of any section. */
function releasedSections(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('## ')) {
      const m = RELEASED_RE.exec(line);
      cur = m ? { version: m[1], heading: line, lines: [] } : null;
      if (cur) out.push(cur);
    } else if (cur && line.trim()) cur.lines.push(line);
  }
  return out;
}

/** Every released section of `baseText` kept in `nextText`. Returns { ok, problems, added }. */
function checkHistory(baseText, nextText) {
  const base = releasedSections(baseText);
  const next = releasedSections(nextText);
  const problems = [];
  if (!base.length) problems.push('the base CHANGELOG has no released "## [x.y.z]" section');
  const byVersion = new Map();
  for (const s of next) {
    if (byVersion.has(s.version)) problems.push(`[${s.version}] appears twice`);
    else byVersion.set(s.version, s);
  }
  const released = new Set(base.map((s) => s.version));
  for (const b of base) {
    const n = byVersion.get(b.version);
    if (!n) { problems.push(`released heading dropped: "${b.heading}"`); continue; }
    if (n.heading !== b.heading) problems.push(`released heading edited: "${b.heading}" is now "${n.heading}"`);
    // Every base line, in order, inside the same section: lines may be added, never removed.
    let at = 0;
    const lost = [];
    for (const l of b.lines) {
      const i = n.lines.indexOf(l, at);
      if (i < 0) lost.push(l); else at = i + 1;
    }
    if (lost.length) problems.push(`[${b.version}] lost ${lost.length} line(s), first: "${lost[0].trim().slice(0, 120)}"`);
  }
  const order = next.filter((s) => released.has(s.version)).map((s) => s.version);
  const want = base.map((s) => s.version).filter((v) => byVersion.has(v));
  if (order.join() !== want.join()) problems.push(`released sections out of order: ${order.slice(0, 5).join(', ')} (want ${want.slice(0, 5).join(', ')})`);
  const firstReleased = next.findIndex((s) => released.has(s.version));
  const added = next.filter((s) => !released.has(s.version));
  for (const s of added) if (firstReleased >= 0 && next.indexOf(s) > firstReleased) problems.push(`new section [${s.version}] sits below a released one`);
  return { ok: problems.length === 0, problems, added: added.map((s) => s.version) };
}

/** The last release's tag: the newest v* tag behind HEAD that is not v<version>. Null if none. */
function baseRef(root, version) {
  try {
    return execFileSync('git', ['-C', root, 'describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', '--exclude', `v${version}`, 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { return null; }
}

/** The CHANGELOG text of an app.asar (its root CHANGELOG.md) or of a plain file. */
function readChangelog(p) {
  if (/\.asar$/i.test(p)) {
    const asar = require('@electron/asar');
    try { return asar.extractFile(p, 'CHANGELOG.md').toString('utf8'); } finally { try { asar.uncache(p); } catch { /* not cached */ } }
  }
  return fs.readFileSync(p, 'utf8');
}

module.exports = { releasedSections, checkHistory, baseRef, readChangelog };

if (require.main === module) {
  const args = process.argv.slice(2);
  const bi = args.indexOf('--base');
  const target = args.find((a, i) => !a.startsWith('--') && (bi < 0 || i !== bi + 1));
  if (!target) { console.error('usage: verify-changelog-history.cjs <app.asar | CHANGELOG.md> [--base <git ref>]'); process.exit(2); }
  const root = path.join(__dirname, '..');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const ref = bi >= 0 ? args[bi + 1] : baseRef(root, version);
  let problems;
  let added = [];
  if (!ref) problems = [`no base: no v* tag behind HEAD other than v${version} (fetch the tags, or pass --base <ref>)`];
  else {
    let baseText = null;
    try { baseText = execFileSync('git', ['-C', root, 'show', `${ref}:CHANGELOG.md`], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* reported below */ }
    let nextText = null;
    try { nextText = readChangelog(target); } catch (e) { problems = [`cannot read the CHANGELOG of ${target}: ${e.message}`]; }
    if (baseText === null) problems = [`cannot read ${ref}:CHANGELOG.md`];
    else if (nextText !== null) ({ problems, added } = checkHistory(baseText, nextText));
  }
  if (!problems.length) { console.log(`CHANGELOG HISTORY OK (base ${ref}; new: ${added.map((v) => `[${v}]`).join(', ') || 'none'})`); process.exit(0); }
  for (const x of problems) console.error(`  - ${x}`);
  console.error(`CHANGELOG HISTORY FAILED (base ${ref || 'none'})`);
  process.exit(1);
}
