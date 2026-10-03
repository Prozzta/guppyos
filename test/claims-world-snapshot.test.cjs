'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');
function loadTs(relative) {
  const filename = path.resolve(ROOT, relative);
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = { exports: {} };
  const localRequire = (specifier) => {
    if (!specifier.startsWith('.')) return require(specifier);
    const target = path.resolve(path.dirname(filename), specifier);
    const tsTarget = target.endsWith('.ts') ? target : `${target}.ts`;
    return fs.existsSync(tsTarget) ? loadTs(path.relative(ROOT, tsTarget)) : require(target);
  };
  new Function('exports', 'require', 'module', js)(loaded.exports, localRequire, loaded);
  return loaded.exports;
}
const { buildClaimsWorldSnapshot } = loadTs('src/main/claims/worldSnapshot.ts');
const { worldView } = loadTs('src/main/claims/world.ts');

function git(cwd, args, env = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com', ...env } }).trim();
}

test('async world snapshot confirms refs, flags missing refs and git changes, and ignores unknown/touch-only state', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-world-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  git(cwd, ['init', '-q']);
  fs.writeFileSync(path.join(cwd, 'changed.txt'), 'before');
  fs.writeFileSync(path.join(cwd, 'touched.txt'), 'same');
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-qm', 'baseline'], { GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' });
  const existing = git(cwd, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(cwd, 'changed.txt'), 'after');
  git(cwd, ['add', 'changed.txt']);
  git(cwd, ['commit', '-qm', 'change'], { GIT_AUTHOR_DATE: '2026-02-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-02-01T00:00:00Z' });
  fs.utimesSync(path.join(cwd, 'touched.txt'), new Date('2026-03-01T00:00:00Z'), new Date('2026-03-01T00:00:00Z'));

  const since = '2026-01-15T00:00:00.000Z';
  const claims = [
    { v: 1, id: 'existing', t: 'claim', kind: 'fact', text: 'a', at: since, wt: since, agent: 'a', mac: 'm', prev: '', source: 'self', refs: [{ type: 'commit', value: existing }] },
    { v: 1, id: 'missing', t: 'claim', kind: 'fact', text: 'b', at: since, wt: since, agent: 'a', mac: 'm', prev: '', source: 'self', refs: [{ type: 'commit', value: '0'.repeat(40) }] },
    { v: 1, id: 'changed', t: 'claim', kind: 'fact', text: 'c', at: since, wt: since, agent: 'a', mac: 'm', prev: '', source: 'self', refs: [{ type: 'file', value: 'changed.txt' }] },
    { v: 1, id: 'touched', t: 'claim', kind: 'fact', text: 'd', at: since, wt: since, agent: 'a', mac: 'm', prev: '', source: 'self', refs: [{ type: 'file', value: 'touched.txt' }] },
  ];
  const state = { v: 1, agent: 'a', registryHash: '', ledgerHead: '', conflicts: [], claims: Object.fromEntries(claims.map(c => [c.id, { id: c.id, status: 'live', sightings: 1, firstAt: since, lastAt: since, pinned: false, reasons: [] }])) };
  const snapshot = await buildClaimsWorldSnapshot(claims, state, cwd);
  const world = { now: since, taskStatus: () => null, fileExists: p => fs.existsSync(path.join(cwd, p)), commitExists: sha => snapshot.commits.get(sha) ?? true, fileChangedSince: (p, at) => snapshot.changedFiles.get(`${p}\0${at}`) ?? false, cardOutcomes: {} };
  const view = worldView(state, claims, [], world);
  assert.equal(view.flags.existing, undefined);
  assert.deepEqual(view.flags.missing, ['stale-ref']);
  assert.deepEqual(view.flags.changed, ['changed-since']);
  assert.equal(view.flags.touched, undefined);

  const unknown = await buildClaimsWorldSnapshot(claims, state, path.join(cwd, 'not-a-repository'));
  const unknownView = worldView(state, claims, [], { ...world, commitExists: sha => unknown.commits.get(sha) ?? true, fileChangedSince: (p, at) => unknown.changedFiles.get(`${p}\0${at}`) ?? false });
  assert.equal(unknownView.flags.existing, undefined);
  assert.equal(unknownView.flags.missing, undefined);
  assert.equal(unknownView.flags.changed, undefined);
});
