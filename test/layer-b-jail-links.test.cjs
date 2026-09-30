'use strict';

/**
 * god (the packages-junction blocker): (a) no junction/symlink under the sandbox base may lead out of
 * it, checked before every launch and after every launch (refuse / abort); (b) the real
 * ~/.codex/packages tree must come out of the run with the same listing. Every fixture lives in a
 * temp dir; nothing here reads or writes the real home.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lb = require('./tools/layer-b-run.cjs');
const src = fs.readFileSync(path.join(__dirname, 'tools', 'layer-b-run.cjs'), 'utf8').replace(/\r\n/g, '\n');

function tmp(t, prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
function junction(t, target, link) {
  try { fs.symlinkSync(target, link, 'junction'); } catch (e) { t.skip(`cannot create a junction here: ${e.code}`); return false; }
  return true;
}
function jail(t) {
  const root = tmp(t, 'lb-jl-');
  const base = path.join(root, 'base');
  const outside = path.join(root, 'outside');
  for (const d of [path.join(base, 'd', 'hive', 'agents', 'lb-codex', '.codex'), path.join(base, 'j', 'home', '.codex'), path.join(outside, 'packages', 'app-server-daemon')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(outside, 'packages', 'app-server-daemon', 'secret.bin'), 'x');
  return { root, base, outside };
}

test('(a) a junction from an agent home to OUTSIDE the jail (the packages case) FAILS the sweep, and the sweep never walks through it', (t) => {
  const j = jail(t);
  if (!junction(t, path.join(j.outside, 'packages'), path.join(j.base, 'd', 'hive', 'agents', 'lb-codex', '.codex', 'packages'))) return;
  const r = lb.jailLinkScan(j.base);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /packages is a link to .*outside.*OUTSIDE the jail/i);
  assert.equal(r.links.length, 1);
  assert.equal(r.links[0].inside, false);
  assert.ok(!r.problems.join(' ').includes('secret.bin') && r.count < 10, 'not descended into the target');
});

test('(a) a junction that stays INSIDE the jail passes; hard-linked files are allowed and listed', (t) => {
  const j = jail(t);
  if (!junction(t, path.join(j.base, 'j', 'home', '.codex'), path.join(j.base, 'd', 'alias'))) return;
  const f = path.join(j.base, 'j', 'home', 'node.exe');
  fs.writeFileSync(f, 'n');
  let hard = true;
  try { fs.linkSync(f, path.join(j.base, 'd', 'node-link.exe')); } catch { hard = false; }
  const r = lb.jailLinkScan(j.base);
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.equal(r.links.length, 1);
  assert.equal(r.links[0].inside, true);
  if (hard) assert.equal(r.hardLinks.length, 2, 'both names of the hard-linked file are listed');
  assert.deepEqual(lb.JAIL_LINK_EXCEPTIONS.reparsePointsOutside, [], 'no reparse point to outside is ever excepted');
});

test('(a) a DANGLING junction, a link reached through the base\'s own real path, a listing error and a tree over the bound all FAIL (fail-closed)', (t) => {
  const j = jail(t);
  const gone = path.join(j.root, 'gone');
  fs.mkdirSync(gone);
  if (!junction(t, gone, path.join(j.base, 'd', 'dangling'))) return;
  fs.rmSync(gone, { recursive: true });
  assert.match(lb.jailLinkScan(j.base).problems.join(' '), /does not resolve/);
  fs.rmSync(path.join(j.base, 'd', 'dangling'));
  // A base that is itself a junction: links are judged against the base's REAL path.
  const real = path.join(j.root, 'realbase');
  fs.mkdirSync(path.join(real, 'x'), { recursive: true });
  const via = path.join(j.root, 'viabase');
  if (!junction(t, real, via)) return;
  if (!junction(t, path.join(real, 'x'), path.join(real, 'inner'))) return;
  assert.equal(lb.jailLinkScan(via).ok, true, 'a link inside the real base is inside');
  // Listing error (not ENOENT) and the bound.
  const bad = lb.jailLinkScan(j.base, { readdir: (d) => { if (d !== j.base) { const e = new Error('EPERM (injected)'); e.code = 'EPERM'; throw e; } return fs.readdirSync(d); } });
  assert.equal(bad.ok, false);
  assert.match(bad.problems.join(' '), /cannot list .*EPERM/);
  assert.match(lb.jailLinkScan(j.base, { maxEntries: 2 }).problems.join(' '), /sweep is incomplete/);
  // A file that vanished mid-walk (ENOENT) is not a problem.
  const vanish = lb.jailLinkScan(j.base, { lstat: (p) => { if (p.endsWith('.codex')) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return fs.lstatSync(p); } });
  assert.equal(vanish.ok, true);
  assert.equal(lb.jailLinkScan(path.join(j.root, 'no-such-base')).ok, false, 'an unresolvable base is not clean');
});

test('(a) the gate REFUSES the launch: a link out of the jail stops the run and throws; a clean jail passes; evidence written', (t) => {
  const j = jail(t);
  const report = path.join(j.root, 'report');
  lb.W.allowRoot(report);
  const run = new lb.LayerB(lb.parseArgs([]));
  run.s = { base: j.base, report };
  let stopped = null;
  run.stop = (why) => { stopped = why; };
  assert.equal(run.jailLinkGate('before launch x').ok, true);
  assert.equal(stopped, null);
  if (!junction(t, path.join(j.outside, 'packages'), path.join(j.base, 'j', 'home', '.codex', 'packages'))) return;
  assert.throws(() => run.jailLinkGate('after launch phase A'), /jail link sweep \(after launch phase A\).*OUTSIDE the jail/);
  assert.match(stopped, /a link leads out of the jail/);
  assert.ok(run.checks.some((c) => !c.ok && /no link out of it \(after launch phase A\)/.test(c.label)));
  const ev = JSON.parse(fs.readFileSync(path.join(report, 'jail-links-after-launch-phase-A.json'), 'utf8'));
  assert.equal(ev.ok, false);
  assert.equal(ev.links[0].inside, false);
});

test('(a) wiring: the gate runs at the top of launch() (after the seed, before the app starts) and after EVERY launch', () => {
  const launch = src.slice(src.indexOf('  async launch(exe, label) {'), src.indexOf('  async launch(exe, label) {') + 1200);
  const gate = launch.indexOf('this.jailLinkGate(`before launch ${label}`);');
  assert.ok(gate > 0 && gate < launch.indexOf('spawn(exe'), 'before the app is spawned');
  for (const label of ['phase A', 'phase B', 'rollback']) {
    assert.match(src, new RegExp(`this\\.checkCodexArgv\\('${label}'\\);\\n\\s*this\\.jailLinkGate\\('after launch ${label}'\\);`), label);
  }
  const main = src.slice(src.indexOf('async main() {'));
  assert.ok(main.indexOf('this.seed();') < main.indexOf("await this.launch(this.exe175, '1.1.75 (phase A)')"), 'the seed comes first');
  const m = src.slice(src.indexOf('  jailLinkGate(label) {'), src.indexOf('  checkCodexArgv(label) {'));
  assert.doesNotMatch(m, /dryRun/, 'both modes');
  assert.match(m, /this\.stop\(/);
});

test('(b) the real ~/.codex/packages listing: unchanged passes, missing both times passes; a changed, added, removed or re-pointed entry FAILS; an unlistable tree FAILS', (t) => {
  const root = tmp(t, 'lb-pk-');
  const pk = path.join(root, 'packages');
  const w = new lb.LiveWatch([], [], [pk]);
  w.start();
  assert.deepEqual(lb.liveTreeProblems(pk, w.before.trees[pk], lb.listingHash(pk)), [], 'missing before and after is fine');
  fs.mkdirSync(path.join(pk, 'app-server-daemon', 'releases', '0.157.1'), { recursive: true });
  fs.writeFileSync(path.join(pk, 'app-server-daemon', 'releases', '0.157.1', 'codex.exe'), 'aaaa');
  assert.match(w.compare([]).failures.join(' '), /appeared during the run/);
  w.start();
  assert.deepEqual(w.compare([]).failures.filter((f) => /packages/.test(f)), [], 'unchanged');
  const f = path.join(pk, 'app-server-daemon', 'releases', '0.157.1', 'codex.exe');
  fs.writeFileSync(f, 'bbbbb');
  assert.match(w.compare([]).failures.join(' '), /listing changed during the run/, 'a size change');
  w.start();
  const st = fs.statSync(f);
  fs.utimesSync(f, st.atime, new Date(st.mtimeMs + 5000));
  assert.match(w.compare([]).failures.join(' '), /listing changed/, 'an mtime change (same size)');
  w.start();
  fs.writeFileSync(path.join(pk, 'install.lock'), '');
  assert.match(w.compare([]).failures.join(' '), /listing changed/, 'a new entry deep or shallow');
  w.start();
  fs.rmSync(path.join(pk, 'install.lock'));
  assert.match(w.compare([]).failures.join(' '), /listing changed/, 'a removed entry');
  // Links are recorded by target, never followed.
  const a = path.join(root, 'relA'); const b = path.join(root, 'relB');
  fs.mkdirSync(a); fs.mkdirSync(b);
  if (!junction(t, a, path.join(pk, 'current'))) return;
  w.start();
  fs.rmSync(path.join(pk, 'current'));
  fs.symlinkSync(b, path.join(pk, 'current'), 'junction');
  const st2 = fs.lstatSync(path.join(pk, 'current'));
  void st2;
  assert.match(w.compare([]).failures.join(' '), /listing changed/, 're-pointed link');
  // The same stat, only the link target differs (e.g. `current` re-pointed within one mtime tick).
  const fake = (target) => lb.listingHash(pk, {
    readdir: (d) => (d === pk ? ['current'] : []),
    lstat: (p) => ({ isSymbolicLink: () => p !== pk, isDirectory: () => p === pk, size: 0, mtimeMs: 1 }),
    readlink: () => target
  });
  assert.notEqual(fake('C:\\a\\0.157.1').hash, fake('C:\\a\\0.159.2').hash, 'the target is part of the listing');
  // Unlistable, and over the bound.
  assert.match(lb.liveTreeProblems(pk, lb.listingHash(pk), lb.listingHash(pk, { readdir: () => { throw Object.assign(new Error('EACCES (injected)'), { code: 'EACCES' }); } })).join(' '), /cannot list the live .* after the run: .*EACCES/);
  assert.match(lb.listingHash(pk, { maxEntries: 1 }).error, /more than 1 entries/);
});

test('(b) wiring: LiveWatch.defaults() adds the real <home>\\.codex\\packages tree (bounded listing, no content read); the end-of-run check names it', () => {
  const d = src.slice(src.indexOf('  static defaults(env = process.env) {'), src.indexOf('  snapshot() {'));
  assert.match(d, /\[path\.join\(home, '\.codex', 'packages'\)\]/);
  const lh = src.slice(src.indexOf('function listingHash('), src.indexOf('function liveTreeProblems('));
  assert.doesNotMatch(lh, /readFileSync|openSync|createReadStream/, 'names, sizes, mtimes and link targets only');
  assert.match(src, /and the real ~\/\.codex\/packages listing is unchanged'/);
  const cmp = src.slice(src.indexOf('  compare(markers) {'), src.indexOf('  compare(markers) {') + 2500);
  assert.match(cmp, /failures\.push\(\.\.\.liveTreeProblems\(t, b, a\)\);/);
});
