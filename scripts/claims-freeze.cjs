#!/usr/bin/env node
/*
 * CLAIMS-FREEZE-GUARD: the claims test freeze, enforced at the cut (docs/release-checklist.md
 * steps 2 and 4). CL-M4-BAR-090 was voided because the freeze was a promise: 1.1.96 shipped claims
 * code during the window, and no release was ever listed claims-frozen.
 *
 * claims-freeze.json (repo root, never packaged) holds:
 *   paths          the frozen paths (src/main/claims, src/shared/cardIds.ts)
 *   window         null, or the open measurement window { id, baseVersion, baseCommit, waivers }
 *                  baseCommit is the measured release's commit (40 hex). waivers is
 *                  { version: the Human's waiver }.
 *   frozenVersions { version: release commit }, the releases whose frozen paths were checked
 *                  empty against baseCommit. The measurement harness reads this list.
 *
 *   node scripts/claims-freeze.cjs gate <tip> <authority>
 *     Before the FULL on the release tip. <authority> is the INT ref that owns the state
 *     (origin/guppy/int-<x>, fetched first). The version comes from <tip>'s tree. The tip's state
 *     must agree with the authority's: the same paths and the same window (id, baseVersion,
 *     baseCommit), and no waiver the authority lacks. Only the authority's waivers count, so a
 *     release branch cannot turn the gate off by editing its own copy (Jim SHOULD).
 *     Prints CLAIMS FREEZE OK, or CLAIMS FREEZE REFUSED (exit 1) when a window is open and <tip>
 *     changes a frozen path, unless the authority waives <tip>'s version. Fails closed: a malformed
 *     or disagreeing state, an authority that cannot be read, or a diff that cannot run refuses.
 *   node scripts/claims-freeze.cjs record <version> <commit>
 *     After the tag push. When a window is open, <commit>'s package.json says <version> (and a local
 *     v<version> tag, if any, names <commit>), and the frozen diff is empty, adds { version: commit }
 *     to the working tree's claims-freeze.json, for a follow-up commit on INT (Jim MUST).
 *     A release whose diff is not empty is never recorded, waived or not: its install forces the cut.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HASH = /^[0-9a-f]{40}$/;
const FILE = 'claims-freeze.json';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Parse and validate the state. Anything malformed throws, so the gate fails closed. */
function parseState(text) {
  let s;
  try { s = JSON.parse(text); } catch (e) { throw new Error(`${FILE} is not JSON: ${e.message}`); }
  if (!isObj(s)) throw new Error(`${FILE} must be an object`);
  if (!Array.isArray(s.paths) || !s.paths.length || !s.paths.every((p) => typeof p === 'string' && p)) throw new Error(`${FILE}: paths must be a non-empty list of paths`);
  if (s.window !== null) {
    const w = s.window;
    if (!isObj(w)) throw new Error(`${FILE}: window must be null or an object`);
    if (typeof w.id !== 'string' || !w.id) throw new Error(`${FILE}: window.id is unset`);
    if (typeof w.baseVersion !== 'string' || !w.baseVersion) throw new Error(`${FILE}: window.baseVersion is unset`);
    if (!HASH.test(w.baseCommit ?? '')) throw new Error(`${FILE}: window.baseCommit must be a 40-hex commit`);
    if (!isObj(w.waivers) || !Object.values(w.waivers).every((v) => typeof v === 'string' && v)) throw new Error(`${FILE}: window.waivers must be { version: waiver }`);
  }
  if (!isObj(s.frozenVersions) || !Object.values(s.frozenVersions).every((h) => HASH.test(h))) throw new Error(`${FILE}: frozenVersions must be { version: 40-hex commit }`);
  return s;
}

/** The frozen paths <tip> changes against <base>. Renames count on both sides. */
function frozenDiff(git, base, tip, paths) {
  return git(['diff', '--name-only', '--no-renames', '-z', base, tip, '--', ...paths]).split('\0').filter(Boolean);
}

/** Why the tip's state disagrees with the authority's, or null when it agrees. frozenVersions may lag. */
function disagreement(tip, auth) {
  if (JSON.stringify(tip.paths) !== JSON.stringify(auth.paths)) return `the tip's paths ${JSON.stringify(tip.paths)} are not the authority's ${JSON.stringify(auth.paths)}`;
  const [t, a] = [tip.window, auth.window];
  if (!t !== !a) return `the tip's window is ${t ? t.id : 'null'}, the authority's is ${a ? a.id : 'null'}`;
  if (!a) return null;
  for (const k of ['id', 'baseVersion', 'baseCommit']) if (t[k] !== a[k]) return `the tip's window.${k} ${t[k]} is not the authority's ${a[k]}`;
  const extra = Object.keys(t.waivers).filter((v) => a.waivers[v] !== t.waivers[v]);
  if (extra.length) return `the tip waives ${extra.join(', ')}, which the authority does not`;
  return null;
}

/** The cut-time gate. { ok, files, waived, why }. */
function gate({ state, tip, version, git }) {
  const w = state.window;
  if (!w) return { ok: true, files: [], waived: false, why: 'no measurement window is open' };
  let files;
  try { files = frozenDiff(git, w.baseCommit, tip, state.paths); } catch (e) {
    return { ok: false, files: [], waived: false, why: `cannot verify ${version} against ${w.id} base ${w.baseCommit}: ${String(e.message).split('\n')[0]}` };
  }
  if (!files.length) return { ok: true, files, waived: false, why: `${version} leaves the frozen paths unchanged since ${w.baseVersion}; record it after the tag push` };
  const waiver = Object.hasOwn(w.waivers, version) ? w.waivers[version] : null;
  if (waiver) return { ok: true, files, waived: true, why: `${version} changes frozen paths during ${w.id}, waived (${waiver}). It is not claims-frozen: its install forces the cut` };
  return { ok: false, files, waived: false, why: `${version} changes frozen paths during ${w.id} (open since ${w.baseVersion}); a release with claims changes needs the Human's waiver in window.waivers` };
}

/** The new state with { version: commit } added. Throws when the release cannot be recorded. */
function record({ state, version, commit, git }) {
  const w = state.window;
  if (!w) throw new Error('not recorded: no measurement window is open');
  if (!HASH.test(commit)) throw new Error(`not recorded: ${commit} is not a 40-hex commit`);
  const had = Object.hasOwn(state.frozenVersions, version) ? state.frozenVersions[version] : null;
  if (had && had !== commit) throw new Error(`not recorded: ${version} is already recorded at ${had}`);
  let says;
  try { says = JSON.parse(git(['show', `${commit}:package.json`])).version; } catch (e) {
    throw new Error(`not recorded: cannot read ${commit}'s package.json: ${String(e.message).split('\n')[0]}`);
  }
  if (says !== version) throw new Error(`not recorded: ${commit} is ${says}, not ${version}`);
  let tagged = null;
  try { tagged = git(['rev-parse', '-q', '--verify', `refs/tags/v${version}^{commit}`]).trim(); } catch { /* no such tag */ }
  if (tagged && tagged !== commit) throw new Error(`not recorded: tag v${version} names ${tagged}, not ${commit}`);
  let files;
  try { files = frozenDiff(git, w.baseCommit, commit, state.paths); } catch (e) {
    throw new Error(`not recorded: cannot verify ${version}: ${String(e.message).split('\n')[0]}`);
  }
  if (files.length) throw new Error(`not recorded: ${version} changes ${files.join(', ')} since ${w.baseVersion}`);
  return { ...state, frozenVersions: { ...state.frozenVersions, [version]: commit } };
}

const gitAt = (cwd) => (args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function main(argv, { cwd = process.cwd(), out = console.log, err = console.error } = {}) {
  const git = gitAt(cwd);
  const [cmd, a, b] = argv;
  try {
    if (cmd === 'gate' && a && b) {
      const remote = /^origin\/(.+)$/.exec(b);
      if (remote) {
        try { git(['fetch', '-q', 'origin', remote[1]]); } catch (e) { throw new Error(`cannot fetch the authority ${b}: ${String(e.message).split('\n')[0]}`); }
      }
      const tip = git(['rev-parse', '--verify', `${a}^{commit}`]).trim();
      let state;
      try { state = parseState(git(['show', `${b}:${FILE}`])); } catch (e) { throw new Error(`cannot read the authority ${b}: ${String(e.message).split('\n')[0]}`); }
      const off = disagreement(parseState(git(['show', `${tip}:${FILE}`])), state);
      if (off) throw new Error(`${a} disagrees with the authority ${b}: ${off}`);
      const version = JSON.parse(git(['show', `${tip}:package.json`])).version;
      const r = gate({ state, tip, version, git });
      for (const f of r.files) out(`  ${f}`);
      out(r.why);
      out(r.ok ? 'CLAIMS FREEZE OK' : 'CLAIMS FREEZE REFUSED');
      return r.ok ? 0 : 1;
    }
    if (cmd === 'record' && a && b) {
      const file = path.join(cwd, FILE);
      const next = record({ state: parseState(fs.readFileSync(file, 'utf8')), version: a, commit: b, git });
      fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
      out(`recorded ${a} at ${b} in ${FILE}; commit it on INT`);
      return 0;
    }
  } catch (e) {
    err(String(e.message).split('\n')[0]);
    out(cmd === 'gate' ? 'CLAIMS FREEZE REFUSED' : 'NOT RECORDED');
    return 1;
  }
  err('usage: claims-freeze.cjs gate <tip> <authority> | record <version> <commit>');
  return 2;
}

module.exports = { parseState, frozenDiff, disagreement, gate, record, main, FILE };
if (require.main === module) process.exit(main(process.argv.slice(2)));
