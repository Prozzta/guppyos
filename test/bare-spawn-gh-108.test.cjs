'use strict';
require('./tools/own-job.cjs');
/**
 * BARE-SPAWN-CWD-HIJACK-108 (Jim's BARE-SPAWN-CENSUS, class A, rows 5 and 6): github.ts listIssues and
 * listCIRuns ran `spawn('gh', ..., { cwd: repo })`. On Windows a bare name is looked up in the child's
 * working directory before PATH, so a gh.exe or gh.com the repo carries ran in place of gh. The fix
 * spawns the full path from resolveExe (GIT-RUN-HARDEN-108: absolute PATH folders only); cwd stays the
 * repo, which gh needs, and is never searched for the program.
 *
 * Agent shells here inherit NoDefaultCurrentDirectoryInExePath, which hides the hole; the packaged app
 * does not set it. Each test deletes it from process.env (the env these spawns inherit) and first
 * proves a bare `gh` in the repo runs the planted program.
 *
 * The plant is a copy of whoami.exe ("ERROR: Invalid argument/option - 'issue'" on gh's arguments);
 * the gh on PATH is a copy of hostname.exe ("sethostname: ..."), so each run says which one ran.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const WIN = process.platform === 'win32';
const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const PLANTED = /Invalid argument\/option/;
const REAL = /sethostname/;

/** As the packaged app runs: no NoDefaultCurrentDirectoryInExePath (any case); PATH set for the test. */
function asTheAppRuns(t, pathValue) {
  const saved = {};
  for (const k of Object.keys(process.env)) {
    if (/^(NoDefaultCurrentDirectoryInExePath|PATH)$/i.test(k)) { saved[k] = process.env[k]; delete process.env[k]; }
  }
  process.env.PATH = pathValue;
  t.after(() => {
    for (const k of Object.keys(process.env)) if (/^(NoDefaultCurrentDirectoryInExePath|PATH)$/i.test(k)) delete process.env[k];
    Object.assign(process.env, saved);
  });
}

/**
 * Copy System32\<exe> to <dir>\gh.exe. A renamed system program finds its message text by its new name
 * (<lang>\gh.exe.mui beside it), so each language's .mui is copied too; without it the errors are blank.
 */
function plant(exe, dir) {
  fs.copyFileSync(path.join(SYS32, exe), path.join(dir, 'gh.exe'));
  for (const lang of fs.readdirSync(SYS32)) {
    const mui = path.join(SYS32, lang, `${exe}.mui`);
    if (!fs.existsSync(mui)) continue;
    fs.mkdirSync(path.join(dir, lang), { recursive: true });
    fs.copyFileSync(mui, path.join(dir, lang, 'gh.exe.mui'));
  }
}

function jail(t, { realGh }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baregh108-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(repo); fs.mkdirSync(bin);
  plant('whoami.exe', repo);
  if (realGh) plant('hostname.exe', bin);
  asTheAppRuns(t, `${bin};${SYS32}`);
  const proof = spawnSync('gh', ['issue'], { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  assert.match(`${proof.stdout}${proof.stderr}`, PLANTED, `precondition: a bare gh in the repo runs the planted program\n${proof.stdout}${proof.stderr}`);
  return { repo };
}

for (const [row, fn] of [['row 5', 'listIssues'], ['row 6', 'listCIRuns']]) {
  test(`${row}: ${fn} runs the gh on PATH, not a gh.exe planted in the repo`, { skip: !WIN }, async (t) => {
    const { repo } = jail(t, { realGh: true });
    const r = await loadTs('src/main/github.ts')[fn](repo);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.doesNotMatch(r.error, PLANTED, `the repo's gh.exe ran: ${r.error}`);
    assert.match(r.error, REAL, `the gh on PATH ran: ${r.error}`);
  });

  test(`${row}: ${fn} with no gh on PATH runs nothing and says so`, { skip: !WIN }, async (t) => {
    const { repo } = jail(t, { realGh: false });
    const r = await loadTs('src/main/github.ts')[fn](repo);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.doesNotMatch(r.error, PLANTED, `the repo's gh.exe ran: ${r.error}`);
    assert.match(r.error, /gh was not found in any absolute folder on PATH/, r.error);
  });
}
