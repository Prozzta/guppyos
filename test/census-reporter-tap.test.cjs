'use strict';
require('./tools/own-job.cjs');
// MUTANT-CENSUS-REPORTER: on Node >=23 `node --test` defaults to the spec reporter, which never
// prints TAP's 'not ok N - title' or '# pass N' lines. A census that spawned '--test' without a
// reporter and parsed 'not ok' saw no failing test, so every mutant read KILLED ELSEWHERE: the
// census passed while proving nothing (tasks-json-split, then nine more, and related-tests'
// base-vs-tip compare read 0 pass / 0 fail and no failing names).
// Pin: every file under test/ and scripts/ that parses TAP output must name a reporter on each
// line that spawns '--test'.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const SELF = path.resolve(__filename);
// What a TAP parse looks for: a failing row or the summary counts.
const PARSES_TAP = /not ok|# pass|# fail/;
const SPAWNS_TEST = /['"`]--test['"`]/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(c|m)?js$/.test(e.name)) out.push(p);
  }
  return out;
}

function offenders(files) {
  const bad = [];
  for (const file of files) {
    if (path.resolve(file) === SELF) continue;
    const src = fs.readFileSync(file, 'utf8');
    if (!PARSES_TAP.test(src)) continue;
    src.split(/\r?\n/).forEach((line, i) => {
      if (SPAWNS_TEST.test(line) && !/--test-reporter/.test(line)) bad.push(`${path.relative(ROOT, file)}:${i + 1}`);
    });
  }
  return bad;
}

test('every --test spawn whose output is parsed as TAP names a reporter on the same line', () => {
  const files = [...walk(path.join(ROOT, 'test')), ...walk(path.join(ROOT, 'scripts'))];
  const bad = offenders(files);
  assert.deepEqual(bad, [], `add '--test-reporter=tap' right after '--test' (Node >=23 defaults to spec, which prints no 'not ok'):\n${bad.join('\n')}`);
});

test('the pin sees the censuses it was written for (not vacuous)', () => {
  const files = walk(path.join(ROOT, 'test', 'tools')).filter((f) => /-mutants\.cjs$/.test(f));
  const covered = files.filter((f) => {
    const src = fs.readFileSync(f, 'utf8');
    return PARSES_TAP.test(src) && src.split(/\r?\n/).some((l) => SPAWNS_TEST.test(l));
  }).map((f) => path.basename(f));
  // MUTANT-RUNNERS-TAP-PARSE: the censuses no longer spawn '--test' themselves; they all go through
  // mutant-tap.cjs's runTests (split out of mutant-runner-helper.cjs by MUTANT-TAP-SPLIT), so that one spawn is what this pin must see, and each census
  // written for it must still reach it (the full every-runner pin is test/mutant-runners-tap.test.cjs).
  const helper = path.join(ROOT, 'test', 'tools', 'mutant-tap.cjs');
  const helperSrc = fs.readFileSync(helper, 'utf8');
  assert.ok(PARSES_TAP.test(helperSrc) && helperSrc.split(/\r?\n/).some((l) => SPAWNS_TEST.test(l)), 'the shared helper spawn is in the pin\'s scope');
  assert.deepEqual(offenders([helper]), [], 'the shared helper names its reporter');
  for (const name of ['agy', 'claims-freeze', 'halfcores-oversubscribe', 'heavy-cpu-shell', 'hook-type-guard', 'owed-continuation',
    'pty-exit-record', 'release-worktrees', 'tasks-json-split', 'wake-stale-loading']) {
    const src = fs.readFileSync(path.join(ROOT, 'test', 'tools', `${name}-mutants.cjs`), 'utf8');
    assert.ok(covered.includes(`${name}-mutants.cjs`) || /\brunTests\(/.test(src), `${name}-mutants.cjs spawns through the pinned helper`);
  }
  // A line that spawns '--test' with no reporter, in a file that parses 'not ok', is caught.
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'census-reporter-'));
  try {
    const f = path.join(tmp, 'x-mutants.cjs');
    fs.writeFileSync(f, "spawnSync(process.execPath, ['--test', T]);\nconst at = /not ok \\d+ - x/;\n");
    assert.equal(offenders([f]).length, 1);
    fs.writeFileSync(f, "spawnSync(process.execPath, ['--test', '--test-reporter=tap', T]);\nconst at = /not ok \\d+ - x/;\n");
    assert.equal(offenders([f]).length, 0);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
