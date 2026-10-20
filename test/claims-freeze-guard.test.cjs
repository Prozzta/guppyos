// CLAIMS-FREEZE-GUARD: the cut-time gate and the claims-frozen record (scripts/claims-freeze.cjs),
// against real git repos. CL-M4-BAR-090 was voided because 1.1.96 shipped claims code during the
// window and no release was ever listed claims-frozen.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const cf = require('../scripts/claims-freeze.cjs');

const ROOT = path.join(__dirname, '..');
const git = (cwd, args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
const state = (window, frozenVersions = {}) => `${JSON.stringify({ paths: ['src/main/claims', 'src/shared/cardIds.ts'], window, frozenVersions }, null, 2)}\n`;
const commit = (cwd, msg) => { git(cwd, ['add', '-A']); git(cwd, ['commit', '-q', '-m', msg]); return git(cwd, ['rev-parse', 'HEAD']).trim(); };
const version = (cwd, v) => write(cwd, 'package.json', `${JSON.stringify({ name: 'x', version: v })}\n`);

/** A repo at the measured release 1.1.90 (base), then INT with the window opened on it. */
function repo(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-freeze-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  git(cwd, ['init', '-q']);
  version(cwd, '1.1.90');
  write(cwd, 'src/main/claims/a.ts', 'export const a = 1;\n');
  write(cwd, 'src/shared/cardIds.ts', 'export const ids = 1;\n');
  write(cwd, 'src/main/other.ts', 'export const o = 1;\n');
  write(cwd, cf.FILE, state(null));
  const base = commit(cwd, 'release 1.1.90');
  const open = (waivers = {}) => { write(cwd, cf.FILE, state({ id: 'CL-M4-TEST', baseVersion: '1.1.90', baseCommit: base, waivers })); return commit(cwd, 'open the window'); };
  const run = (...argv) => { const lines = []; const code = cf.main(argv, { cwd, out: (l) => lines.push(l), err: (l) => lines.push(l) }); return { code, text: lines.join('\n') }; };
  return { cwd, base, open, run };
}

test('no window open: the gate passes, even over claims changes', (t) => {
  const r = repo(t);
  write(r.cwd, 'src/main/claims/a.ts', 'export const a = 2;\n');
  version(r.cwd, '1.1.91');
  commit(r.cwd, 'claims change');
  const out = r.run('gate', 'HEAD');
  assert.strictEqual(out.code, 0, out.text);
  assert.match(out.text, /no measurement window is open\nCLAIMS FREEZE OK$/);
});

test('window open: a release that changes src/main/claims is REFUSED and names the file', (t) => {
  const r = repo(t);
  r.open();
  write(r.cwd, 'src/main/claims/a.ts', 'export const a = 2;\n');
  write(r.cwd, 'src/main/claims/new.ts', 'export const n = 1;\n');
  version(r.cwd, '1.1.96');
  commit(r.cwd, 'claims change');
  const out = r.run('gate', 'HEAD');
  assert.strictEqual(out.code, 1, out.text);
  assert.match(out.text, /^ {2}src\/main\/claims\/a\.ts$/m);
  assert.match(out.text, /^ {2}src\/main\/claims\/new\.ts$/m);
  assert.match(out.text, /1\.1\.96 changes frozen paths during CL-M4-TEST/);
  assert.match(out.text, /CLAIMS FREEZE REFUSED$/);
});

test('window open: src/shared/cardIds.ts is frozen too; a change elsewhere passes as recordable', (t) => {
  const r = repo(t);
  r.open();
  write(r.cwd, 'src/main/other.ts', 'export const o = 2;\n');
  version(r.cwd, '1.1.91');
  commit(r.cwd, 'non-claims change');
  const ok = r.run('gate', 'HEAD');
  assert.strictEqual(ok.code, 0, ok.text);
  assert.match(ok.text, /1\.1\.91 leaves the frozen paths unchanged since 1\.1\.90; record it after the tag push\nCLAIMS FREEZE OK$/);
  write(r.cwd, 'src/shared/cardIds.ts', 'export const ids = 2;\n');
  version(r.cwd, '1.1.92');
  commit(r.cwd, 'cardIds change');
  const no = r.run('gate', 'HEAD');
  assert.strictEqual(no.code, 1, no.text);
  assert.match(no.text, /^ {2}src\/shared\/cardIds\.ts$/m);
});

test('window open: moving a file out of src/main/claims is REFUSED (renames count on both sides)', (t) => {
  const r = repo(t);
  r.open();
  git(r.cwd, ['mv', 'src/main/claims/a.ts', 'src/main/a.ts']);
  version(r.cwd, '1.1.91');
  commit(r.cwd, 'move');
  const out = r.run('gate', 'HEAD');
  assert.strictEqual(out.code, 1, out.text);
  assert.match(out.text, /^ {2}src\/main\/claims\/a\.ts$/m);
});

test('waiver: only the waived version passes, and a waived release is never recorded', (t) => {
  const r = repo(t);
  r.open({ '1.1.96': 'the Human, 2026-10-20' });
  write(r.cwd, 'src/main/claims/a.ts', 'export const a = 2;\n');
  version(r.cwd, '1.1.96');
  const tip = commit(r.cwd, 'waived claims change');
  const ok = r.run('gate', 'HEAD');
  assert.strictEqual(ok.code, 0, ok.text);
  assert.match(ok.text, /waived \(the Human, 2026-10-20\)\. It is not claims-frozen: its install forces the cut\nCLAIMS FREEZE OK$/);
  const rec = r.run('record', '1.1.96', tip);
  assert.strictEqual(rec.code, 1, rec.text);
  assert.match(rec.text, /not recorded: 1\.1\.96 changes src\/main\/claims\/a\.ts since 1\.1\.90/);
  assert.deepStrictEqual(cf.parseState(fs.readFileSync(path.join(r.cwd, cf.FILE), 'utf8')).frozenVersions, {});
  version(r.cwd, '1.1.97');
  commit(r.cwd, 'the next release, not waived');
  const no = r.run('gate', 'HEAD');
  assert.strictEqual(no.code, 1, no.text);
});

test('record: an empty diff appends { version: commit }; a repeat is a no-op; a clash, a short hash or no window refuse', (t) => {
  const r = repo(t);
  r.open();
  write(r.cwd, 'src/main/other.ts', 'export const o = 2;\n');
  version(r.cwd, '1.1.91');
  const tip = commit(r.cwd, 'release 1.1.91');
  const rec = r.run('record', '1.1.91', tip);
  assert.strictEqual(rec.code, 0, rec.text);
  const read = () => cf.parseState(fs.readFileSync(path.join(r.cwd, cf.FILE), 'utf8'));
  assert.deepStrictEqual(read().frozenVersions, { '1.1.91': tip });
  assert.strictEqual(read().window.baseCommit, r.base, 'the window is kept');
  assert.strictEqual(r.run('record', '1.1.91', tip).code, 0, 'the same hash again');
  const clash = r.run('record', '1.1.91', r.base);
  assert.strictEqual(clash.code, 1);
  assert.match(clash.text, /already recorded at /);
  const short = r.run('record', '1.1.92', tip.slice(0, 8));
  assert.strictEqual(short.code, 1);
  assert.match(short.text, /is not a 40-hex commit/);
  assert.throws(() => cf.record({ state: cf.parseState(state(null)), version: '1.1.92', commit: tip, git: () => '' }), /no measurement window is open/);
});

test('fails closed: a malformed state, an unknown base commit or a tip without the state file refuse', (t) => {
  for (const bad of ['{', '[]', JSON.stringify({ paths: [], window: null, frozenVersions: {} }),
    state({ id: 'W', baseVersion: '1.1.90', baseCommit: 'v1.1.90', waivers: {} }),
    state({ id: 'W', baseVersion: '1.1.90', baseCommit: 'a'.repeat(40) }),
    state(null, { '1.1.91': 'v1.1.91' })]) {
    assert.throws(() => cf.parseState(bad), /claims-freeze\.json/, bad);
  }
  const r = repo(t);
  write(r.cwd, cf.FILE, state({ id: 'W', baseVersion: '1.1.90', baseCommit: 'b'.repeat(40), waivers: {} }));
  version(r.cwd, '1.1.91');
  commit(r.cwd, 'a base that is not here');
  const out = r.run('gate', 'HEAD');
  assert.strictEqual(out.code, 1, out.text);
  assert.match(out.text, /cannot verify 1\.1\.91 against W base b{40}/);
  fs.rmSync(path.join(r.cwd, cf.FILE));
  commit(r.cwd, 'no state file');
  const gone = r.run('gate', 'HEAD');
  assert.strictEqual(gone.code, 1, gone.text);
  assert.match(gone.text, /CLAIMS FREEZE REFUSED$/);
});

test('the gate reads the state and the version from the tip, not the working tree', (t) => {
  const r = repo(t);
  r.open();
  write(r.cwd, 'src/main/claims/a.ts', 'export const a = 2;\n');
  version(r.cwd, '1.1.96');
  commit(r.cwd, 'claims change');
  write(r.cwd, cf.FILE, state(null));
  version(r.cwd, '9.9.9');
  const out = r.run('gate', 'HEAD');
  assert.strictEqual(out.code, 1, out.text);
  assert.match(out.text, /1\.1\.96 changes frozen paths/);
});

test('PIN: the repo state parses, freezes exactly the claims paths, is not packaged, and the checklist runs both steps', () => {
  const s = cf.parseState(fs.readFileSync(path.join(ROOT, cf.FILE), 'utf8'));
  assert.deepStrictEqual(s.paths, ['src/main/claims', 'src/shared/cardIds.ts']);
  const builder = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  assert.doesNotMatch(builder, /claims-freeze/, 'claims-freeze.json is not in the packaged files');
  const checklist = fs.readFileSync(path.join(ROOT, 'docs', 'release-checklist.md'), 'utf8');
  assert.match(checklist, /node scripts\/claims-freeze\.cjs gate <tip>/);
  assert.match(checklist, /node scripts\/claims-freeze\.cjs record <version> <tag commit>/);
});
