'use strict';
require('../tools/own-job.cjs');
/**
 * HEAVY-ELECTRON-TAG (Andy's HLFN audit, god's plan 2026-10-23 17:00Z). Two holes, measured on 1.1.100:
 *   - A FILTERED run (`npm test -- <needle>`, `run-tests.cjs <needle>`, and the lease on the runner's
 *     argv) that picked fewer than SUITE_MANY_FILES files was light whatever they were:
 *     `npm test -- activity-lag` picks ONE Electron harness file, heavy alone, and ran light.
 *     Now the picked files are judged as `node --test <those files>` is: what they load, their tag.
 *   - test/quit-sweep.electron.test.cjs starts a real Electron through the harness launcher held in a
 *     variable, which the scan cannot follow: alone it was light. It now declares `@heavy-lock live`.
 * The CENSUS runs the real classifier on the real tree: every test file that calls the harness's
 * Electron launcher or loads the harness runner is heavy alone, and the read-only harness files stay light.
 * Fixture paths are invented; the fixture's Electron files are text, never run.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('../load-ts.cjs');
const { readSource } = require('../read-source.cjs');

const HJF = 'src/main/heavyJob.ts';
const HKF = 'src/main/hooks.ts';
const HJ = loadTs(HJF);
const HK = loadTs(HKF);
const REPO = path.resolve(__dirname, '..', '..');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-et-'));
const realEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
test.after(() => { for (const [k, v] of Object.entries(realEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } fs.rmSync(JAIL, { recursive: true, force: true }); });

// Built from parts, so this file's own text neither calls the harness nor loads its runner (the census
// reads it too).
const HARNESS_RUN = ['electron-harness', 'run.cjs'].join('/');
const LAUNCH = ['harness', 'Electron'].join('') + '()';
const TAG = ['// @heavy-lock', 'live: starts a real Electron'].join(' ');

/** The agent's checkout: Electron files (by load, by tag, through a helper), light files (one reads a
 *  harness file as text), and test/bnd/: 18 light files and one Electron file whose name sorts last. */
const AGENT = path.join(JAIL, 'agent');
const T = path.join(AGENT, 'test');
for (const d of ['tools', 'het-helpers', 'bnd']) fs.mkdirSync(path.join(T, d), { recursive: true });
const FILES = {
  'het-electron.test.cjs': `const { run } = require('./${HARNESS_RUN}');\nrun('scene');\n`,
  'het-tagged.test.cjs': `'use strict';\n${TAG}\nconst exe = require('./electron-harness/electron-bin.cjs').${LAUNCH};\nrequire('node:child_process').spawn(exe, []);\n`,
  'het-helper.test.cjs': `const h = require('./het-helpers/h.cjs');\nh();\n`,
  'het-helpers/h.cjs': `module.exports = () => require('../${HARNESS_RUN}').run('x');\n`,
  'het-light-a.test.cjs': `const fs = require('node:fs');\nconst src = fs.readFileSync('test/electron-harness/scenarios/tui.ts', 'utf8');\nrequire('node:assert').ok(src);\n`,
  'het-light-b.test.cjs': `require('node:assert').equal(1, 1);\n`,
  'bnd/bnd-zz-electron.test.cjs': `require('../${HARNESS_RUN}').run('b');\n`,
};
for (let i = 0; i < 18; i++) FILES[`bnd/bnd-${String(i).padStart(2, '0')}.test.cjs`] = `require('node:assert').equal(${i}, ${i});\n`;
// UHera F1: test/f1/: nine light files, each through its own light helper, and a tenth (sorts last)
// that launches through its helper. One read budget for the run ran out on the nine helpers.
fs.mkdirSync(path.join(T, 'f1', 'f1h'), { recursive: true });
for (const c of 'abcdefghi') {
  FILES[`f1/f1-${c}.test.cjs`] = `const h = require('./f1h/${c}.cjs');\nrequire('node:assert').ok(h);\n`;
  FILES[`f1/f1h/${c}.cjs`] = `module.exports = '${c}';\n`;
}
FILES['f1/f1-z.test.cjs'] = `const h = require('./f1h/z.cjs');\nh();\n`;
FILES['f1/f1h/z.cjs'] = `module.exports = () => require('../../${HARNESS_RUN}').run('z');\n`;
// UHera F3: an Electron file over HEAVY_SCRIPT_MAX_BYTES: there, but the lock cannot read it.
FILES['het-big.test.cjs'] = `require('./${HARNESS_RUN}').run('big');\n` + `// ${'x'.repeat(120)}\n`.repeat(3000);
for (const [n, t] of Object.entries(FILES)) fs.writeFileSync(path.join(T, n), t);
const RUNNER = ['test', 'tools', 'run-tests.cjs'].join('/');
fs.copyFileSync(path.resolve(__dirname, '..', 'tools', 'run-tests.cjs'), path.join(AGENT, RUNNER));
const NT = ['npm', 'test'].join(' ');
const AGENTP = AGENT.replace(/\\/g, '/');
const AWAY = path.join(JAIL, 'away');
fs.mkdirSync(AWAY);

const cls = (M, cmd, ctx, tool = 'Bash') => M.classifyHeavy(tool, { command: cmd }, ctx);
const sure = (g) => g.heavy && !g.provisional;

// ─── KILLERS (named assertions; the census checks each mutant dies at the right one) ─────────

const K = {};

/** A filtered run is judged by the files it picks, as `node --test <those files>` is. */
K.pick = async ({ HJ: M, HK: H }) => {
  const ctx = H.HookServer.heavyScriptCtx(AGENT);
  for (const run of [`${NT} --`, `node ${RUNNER}`]) {
    const one = cls(M, `${run} het-electron`, ctx);
    assert.ok(sure(one), `ONE ELECTRON FILE PICKED IS HEAVY (${run}): ${JSON.stringify(one)}`);
    assert.match(one.why, /\(picks 1 test file: node het-electron\.test\.cjs \(loads electron-harness\/run/, `THE WHY NAMES THE PICKED FILE (${run}): ${one.why}`);
    assert.match(cls(M, `${run} het-tagged`, ctx).why ?? '', /declares @heavy-lock live/, `A TAGGED FILE PICKED IS HEAVY (${run})`);
    assert.ok(sure(cls(M, `${run} het-helper`, ctx)), `AN ELECTRON FILE THROUGH A HELPER IS HEAVY (${run})`);
    // god: the false-positive side. A file that reads a harness file as text runs nothing.
    assert.deepEqual(cls(M, `${run} het-light`, ctx), { heavy: false }, `A READ-ONLY HARNESS FILE STAYS LIGHT (${run})`);
    // Every picked file is judged, not the first: the light ones sort before het-tagged.
    assert.ok(sure(cls(M, `${run} het-light het-tagged`, ctx)), `EVERY PICKED FILE IS JUDGED (${run})`);
  }
  // npm run test* is the same filter.
  assert.ok(sure(cls(M, 'npm run test:focused -- het-electron', ctx)), 'NPM RUN TEST: ONE ELECTRON FILE PICKED IS HEAVY');
  // The runner's own repo: from a folder with no test/, by an absolute runner, npm --prefix and a relative runner.
  const away = H.HookServer.heavyScriptCtx(AWAY);
  assert.equal(away.testFiles(), null, 'the caller\'s folder has no test/ to list');
  assert.ok(sure(cls(M, `node ${AGENTP}/${RUNNER} het-electron`, away)), 'FROM ANOTHER FOLDER: THE RUNNER\'S OWN FILES ARE READ (absolute runner)');
  assert.ok(sure(cls(M, `npm --prefix ${AGENTP} test -- het-tagged`, away)), 'FROM ANOTHER FOLDER: THE RUNNER\'S OWN FILES ARE READ (npm --prefix)');
  assert.ok(sure(cls(M, `node agent/${RUNNER} het-electron`, H.HookServer.heavyScriptCtx(JAIL))), 'A RELATIVE RUNNER PATH: ITS REPO\'S FILES ARE READ');
  assert.deepEqual(cls(M, `node ${AGENTP}/${RUNNER} het-light`, away), { heavy: false }, 'FROM ANOTHER FOLDER: LIGHT PICKS STAY LIGHT');
  // A file the lister names but that does not read is not a program here (no provisional "cannot read").
  assert.deepEqual(cls(M, `node ${AGENTP}/${RUNNER} gone`, { ...away, testFiles: () => ['gone.test.cjs'] }), { heavy: false }, 'A PICKED FILE THAT DOES NOT READ IS NOT A PROGRAM');
  // Without a reader the old rule stands: a filtered run of few files is light.
  const { readScript: _r, ...noRead } = ctx;
  assert.deepEqual(cls(M, `${NT} -- het-electron`, noRead), { heavy: false }, 'NO READER: A FEW PICKED FILES ARE LIGHT AS BEFORE');
};

/** The 19/20 boundary: 19 picks are judged file by file (the Electron one is the 19th), 20 are the suite. */
K.boundary = async ({ HJ: M, HK: H }) => {
  const ctx = H.HookServer.heavyScriptCtx(AGENT);
  assert.deepEqual(cls(M, `${NT} -- bnd-0 bnd-1`, ctx), { heavy: false }, 'BOUNDARY: 18 LIGHT PICKS STAY LIGHT');
  const nineteen = cls(M, `${NT} -- bnd-`, ctx);
  assert.ok(sure(nineteen) && nineteen.kind === 'bench', `BOUNDARY: 19 PICKS ARE READ TO THE LAST ONE: ${JSON.stringify(nineteen)}`);
  assert.match(nineteen.why, /^npm test -- bnd- \(picks 19 test files: .*bnd-zz-electron\.test\.cjs/, `BOUNDARY: THE WHY NAMES THE 19TH: ${nineteen.why}`);
  assert.deepEqual(cls(M, `${NT} -- bnd- het-light-b`, ctx), { heavy: true, kind: 'suite', why: 'npm test -- bnd- het-light-b (matches 20 test files)' }, 'BOUNDARY: 20 PICKS ARE THE SUITE');
  assert.equal(M.SUITE_MANY_FILES, 20, 'THRESHOLD IS 20');
};

/** UHera F1: each pick has its own helper reads; nine helper-using light picks do not hide a tenth. */
K.budget = async ({ HJ: M, HK: H }) => {
  const ctx = H.HookServer.heavyScriptCtx(AGENT);
  assert.ok(sure(cls(M, 'node --test test/f1/f1-z.test.cjs', ctx)), 'the tenth is heavy alone (through its helper)');
  assert.deepEqual(cls(M, `${NT} -- f1-a f1-b f1-c f1-d f1-e f1-f f1-g f1-h f1-i`, ctx), { heavy: false }, 'the nine light picks are light');
  const ten = cls(M, `${NT} -- f1-`, ctx);
  assert.ok(sure(ten), `TEN PICKS: THE ONE LAUNCHING THROUGH A HELPER IS HEAVY: ${JSON.stringify(ten)}`);
  assert.match(ten.why, /^npm test -- f1- \(picks 10 test files: node f1-z\.test\.cjs via z\.cjs \(loads electron-harness\/run/, `TEN PICKS: THE WHY NAMES IT: ${ten.why}`);
};

/** UHera F3: a pick that is there but does not read (oversized) is unknown, as under `node --test`. */
K.size = async ({ HJ: M, HK: H }) => {
  const ctx = H.HookServer.heavyScriptCtx(AGENT);
  assert.ok(fs.statSync(path.join(T, 'het-big.test.cjs')).size > M.HEAVY_SCRIPT_MAX_BYTES, 'the fixture is over the read cap');
  const alone = cls(M, 'node --test test/het-big.test.cjs', ctx);
  assert.ok(alone.heavy && alone.provisional, `node --test: an oversized file is provisional heavy: ${JSON.stringify(alone)}`);
  for (const run of [`${NT} --`, `node ${RUNNER}`]) {
    const big = cls(M, `${run} het-big`, ctx);
    assert.ok(big.heavy && big.provisional, `AN OVERSIZED PICK IS PROVISIONAL HEAVY (${run}): ${JSON.stringify(big)}`);
    assert.match(big.why, /\(picks 1 test file: het-big\.test\.cjs \(a script the lock cannot read yet\)\)$/, `AN OVERSIZED PICK: THE WHY SAYS SO (${run}): ${big.why}`);
    assert.ok(sure(cls(M, `${run} het-big het-electron`, ctx)), `A DEFINITE PICK BEATS AN UNREADABLE ONE (${run})`);
  }
};

/** UHera F2: the runner called by a short path from inside its repo (test/ or test/tools/) lists that repo. */
K.short = async ({ HJ: M, HK: H }) => {
  const ctx = H.HookServer.heavyScriptCtx(REPO);
  const shapes = [
    ['Bash', 'cd test && node tools/run-tests.cjs activity-lag'],
    ['Bash', 'cd test/tools && node run-tests.cjs activity-lag'],
    ['Bash', 'cd test/tools && node ./run-tests.cjs activity-lag'],
    ['PowerShell', 'cd test; node tools\\run-tests.cjs activity-lag'],
    ['PowerShell', 'cd test\\tools; node .\\run-tests.cjs activity-lag'],
    // UHera's NIT: any runner path, so from a deeper folder of the repo too (the script's folder, two up).
    ['Bash', 'cd test/heavy-lock && node ../tools/run-tests.cjs activity-lag'],
    ['PowerShell', 'cd test\\heavy-lock; node ..\\tools\\run-tests.cjs activity-lag'],
    ['Bash', 'cd src/main && node ../../test/tools/run-tests.cjs activity-lag'],
  ];
  for (const [tool, cmd] of shapes) {
    const g = cls(M, cmd, ctx, tool);
    assert.ok(sure(g) && /activity-lag-151\.test\.cjs/.test(g.why), `SHORT RUNNER PATH: ITS REPO'S PICKS ARE READ (${tool}: ${cmd}): ${JSON.stringify(g)}`);
  }
  assert.ok(sure(cls(M, 'node tools/run-tests.cjs activity-lag', H.HookServer.heavyScriptCtx(path.join(REPO, 'test')))), 'SHORT RUNNER PATH: FROM A PROCESS IN test/');
  assert.deepEqual(cls(M, 'cd test && node tools/run-tests.cjs update-feed-owner', ctx), { heavy: false }, 'SHORT RUNNER PATH: A LIGHT PICK STAYS LIGHT');
};

/** Jim's NIT: a UNC runner path lists the share's repo (//srv/share), forward and backslash forms. */
K.unc = async ({ HJ: M, HK: H }) => {
  const base = H.HookServer.heavyScriptCtx(AWAY);
  const shapes = [
    ['Bash', 'node //srv/share/test/tools/run-tests.cjs het-electron', '//srv/share'],
    ['Bash', "node '\\\\srv\\share\\test\\tools\\run-tests.cjs' het-electron", '//srv/share'],
    ['PowerShell', 'node \\\\srv\\share\\test\\tools\\run-tests.cjs het-electron', '//srv/share'],
    ['Bash', 'node //srv/share/proj/test/tools/run-tests.cjs het-electron', '//srv/share/proj'],
    ['PowerShell', 'node \\\\srv\\share\\proj\\test\\tools\\run-tests.cjs het-electron', '//srv/share/proj'],
  ];
  for (const [tool, cmd, want] of shapes) {
    const seen = [];
    cls(M, cmd, { ...base, testFiles: (cd, repo) => { seen.push(repo); return null; } }, tool);
    assert.deepEqual(seen, [want], `UNC RUNNER PATH: THE SHARE IS ITS REPO (${tool}: ${cmd}): ${JSON.stringify(seen)}`);
  }
  // Above the share's top there is no repo (the drive-top guard, for a share).
  const seen = [];
  cls(M, 'node //srv/share/tools/run-tests.cjs het-electron', { ...base, testFiles: (cd, repo) => { seen.push(repo); return null; } });
  assert.deepEqual(seen, [undefined], `UNC RUNNER PATH: ABOVE THE SHARE IS NO REPO: ${JSON.stringify(seen)}`);
};

/** The lease judges a runner's argv the same way, in the process's own folder. */
K.lease = async ({ HJ: M, HK: H }) => {
  const lock = new M.HeavyJobLock({ limit: () => 1, setTimer: () => ({}), clearTimer: () => {}, leasePollMs: 1, classifyCtx: (cwd) => H.HookServer.heavyScriptCtx(cwd) });
  const runner = path.join(AGENT, RUNNER);
  const light = await lock.lease('cx', { op: 'acquire', pid: 5101, createdMs: Date.now(), runner: [runner, 'het-light'], cwd: AWAY });
  assert.equal(light.state, 'light', `LEASE: LIGHT PICKS ARE LIGHT: ${JSON.stringify(light)}`);
  const e = await lock.lease('cx', { op: 'acquire', pid: 5102, createdMs: Date.now(), runner: [runner, 'het-electron'], cwd: AWAY });
  assert.notEqual(e.state, 'light', `LEASE: AN ELECTRON PICK IS HEAVY: ${JSON.stringify(e)}`);
};

// ─── CENSUS (the real tree, the real classifier) ────────────────────────────────────────────

/** Test files that start Electron: they call the harness launcher or load the harness runner (run*.cjs). */
const LAUNCHES = /\bharnessElectron\s*\(|require\(\s*['"][^'"]*electron-harness\/run[\w.-]*['"]/;
/** Files that only read harness files as text, or call harness helpers that start nothing. */
const READ_ONLY = ['test/automatic-submit-wiring.test.cjs', 'test/harness-crashpad-guard.test.cjs', 'test/theme-bundle-boundaries.test.cjs',
  'test/related-tests-198.test.cjs', 'test/icon-speck.test.cjs', 'test/electron-view-self-heal-198.test.cjs'];
/** Classifier tests that hold a launch as fixture TEXT (a string they classify), never run it. */
const TEXT_ONLY = ['test/heavy-lock/heavy-lock-live-file-192.test.cjs'];
const tracked = execFileSync('git', ['-C', REPO, 'ls-files', '--', 'test/*.test.cjs', 'test/**/*.test.cjs'], { encoding: 'utf8' }).split('\n').filter(Boolean);

/** `strip`: test hook, a file whose `@heavy-lock live` line the reader drops (the tag-removed mutant). */
K.census = async ({ HJ: M, HK: H }, _t, strip) => {
  const base = H.HookServer.heavyScriptCtx(REPO);
  const ctx = strip ? { ...base, readScript: (p, cd) => { const t = base.readScript(p, cd); return t !== null && p.replace(/\\/g, '/').endsWith(strip) ? t.replace(/^.*@heavy-lock live.*$/m, '') : t; } } : base;
  for (const f of TEXT_ONLY) assert.ok(tracked.includes(f), `${f} is tracked`);
  const launchers = tracked.filter((f) => !TEXT_ONLY.includes(f) && LAUNCHES.test(fs.readFileSync(path.join(REPO, f), 'utf8')));
  assert.ok(launchers.includes('test/quit-sweep.electron.test.cjs') && launchers.includes('test/activity-lag-151.test.cjs') && launchers.length >= 30,
    `the census finds the launchers (${launchers.length}): ${launchers.slice(0, 5).join(', ')}`);
  const light = launchers.filter((f) => !sure(cls(M, `node --test ${f}`, ctx)));
  assert.deepEqual(light, [], `CENSUS: EVERY TEST FILE THAT STARTS ELECTRON IS HEAVY ALONE. Light: ${light.join(', ')}. Fix: add "// @heavy-lock live: <why>" near its top.`);
  for (const f of READ_ONLY) {
    assert.ok(tracked.includes(f), `${f} is tracked`);
    assert.deepEqual(cls(M, `node --test ${f}`, ctx), { heavy: false }, `CENSUS: A READ-ONLY HARNESS FILE STAYS LIGHT ALONE: ${f}`);
  }
  // UHera F1 on the real tree: eight helper-using light picks before one that launches through a helper.
  const nine = cls(M, `${NT} -- heavy-lock/heavy-lock-adhoc-node.test.cjs tes-bubbles-188.test.cjs layer-b-codex-argv.test.cjs heavy-lock/heavy-lock-electron-tag-1101.test.cjs related-tests-198.test.cjs test-runner-glob.test.cjs ps-policy-temp-leak-198.test.cjs layer-b-git-env.test.cjs load-flakes-followups`, ctx);
  assert.ok(sure(nine) && /picks 9 test files: .*load-flakes-followups/.test(nine.why), `CENSUS: UHERA'S 9-PICK LIST IS HEAVY BY load-flakes-followups: ${JSON.stringify(nine)}`);
};

test('a filtered run is judged by the files it picks (npm test, npm run test*, the runner from anywhere)', (t) => K.pick({ HJ, HK }, t));
test('the 19/20 boundary: 19 picks are read to the last one, 20 are the suite', (t) => K.boundary({ HJ, HK }, t));
test('the lease judges a runner\'s picks the same way', (t) => K.lease({ HJ, HK }, t));
test('UHera F1: each pick has its own helper reads (ten picks, the tenth launches through a helper)', (t) => K.budget({ HJ, HK }, t));
test('UHera F3: an oversized pick is provisional heavy, as under node --test', (t) => K.size({ HJ, HK }, t));
test('UHera F2: a short runner path from inside test/ or test/tools/ (Bash and PowerShell)', (t) => K.short({ HJ, HK }, t));
test('Jim NIT: a UNC runner path (//srv/share, forward and backslash) lists the share\'s repo', (t) => K.unc({ HJ, HK }, t));
test('CENSUS: every test file that starts Electron is heavy alone; the read-only harness files stay light', (t) => K.census({ HJ, HK }, t));

// ─── MUTANT CENSUS ───────────────────────────────────────────────────────────────────────────

function mutateText(rel, edits, tag) {
  let text = readSource(rel);
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  return text;
}

const MUTANTS = [
  { file: HJF, name: 'few picks are not judged (1.1.100)', edits: [['  if (!n || !ctx.readScript) return { heavy: false };', '  if (true) return { heavy: false };']],
    killer: 'pick', dies: /ONE ELECTRON FILE PICKED IS HEAVY \(npm test --\)/ },
  { file: HJF, name: 'only the first picked file is judged', edits: [['  for (const p of picked.map((f) => base + f)) {', '  for (const p of picked.map((f) => base + f).slice(0, 1)) {']],
    killer: 'pick', dies: /EVERY PICKED FILE IS JUDGED/ },
  { file: HJF, name: 'one shared read budget for all the picks (2abfc3bb, UHera F1)', edits: [
    ['  let unknown: HeavyClass | null = null;', '  let unknown: HeavyClass | null = null; const all: string[] = [];'],
    ['    const c = classifyNodeCode({ script: null, preloads: [p], inline: null, stdin: false }, { ...ctx, stdin: undefined }, false, 1 + HEAVY_JS_MAX_FILES);\n    if (c.heavy && !c.provisional) return say(c);\n    if (c.heavy && !unknown) unknown = c;\n  }',
      '    all.push(p);\n  }\n  const c = classifyNodeCode({ script: null, preloads: all, inline: null, stdin: false }, { ...ctx, stdin: undefined }, false, all.length + HEAVY_JS_MAX_FILES);\n  if (c.heavy && !c.provisional) return say(c);\n  if (c.heavy && !unknown) unknown = c;']],
    killer: 'budget', dies: /TEN PICKS: THE ONE LAUNCHING THROUGH A HELPER IS HEAVY/ },
  { file: HJF, name: 'a pick reads no helpers', edits: [['false, 1 + HEAVY_JS_MAX_FILES);', 'false, 1);']],
    killer: 'pick', dies: /AN ELECTRON FILE THROUGH A HELPER IS HEAVY \(npm test --\)/ },
  { file: HJF, name: 'the picks are read from the caller\'s folder, not the runner\'s repo', edits: [["  const base = root ? `${root.replace(/[\\\\/]+$/, '')}/test/` : 'test/';", "  const base = 'test/';"]],
    killer: 'pick', dies: /FROM ANOTHER FOLDER: THE RUNNER'S OWN FILES ARE READ \(absolute runner\)/ },
  { file: HJF, name: 'a missing pick is judged (provisional heavy)', edits: [['      if (!gone && !unknown) unknown = unreadable(p, ctx);', '      if (!unknown) unknown = unreadable(p, ctx);']],
    killer: 'pick', dies: /A PICKED FILE THAT DOES NOT READ IS NOT A PROGRAM/ },
  { file: HJF, name: 'an oversized pick is dropped (UHera F3)', edits: [['      if (!gone && !unknown) unknown = unreadable(p, ctx);', '']],
    killer: 'size', dies: /AN OVERSIZED PICK IS PROVISIONAL HEAVY \(npm test --\)/ },
  { file: HJF, name: 'an unreadable pick ends the judging (a later definite pick unseen)', edits: [['      if (!gone && !unknown) unknown = unreadable(p, ctx);', '      if (!gone) return say(unreadable(p, ctx));']],
    killer: 'size', dies: /A DEFINITE PICK BEATS AN UNREADABLE ONE \(npm test --\)/ },
  { file: HJF, name: 'the why does not name the pick', edits: [['const say = (c: HeavyClass): HeavyClass => ({ ...c, why: ', 'const say = (c: HeavyClass): HeavyClass => ({ ...c, w0: ']],
    killer: 'pick', dies: /THE WHY NAMES THE PICKED FILE/ },
  { file: HJF, name: 'a short runner path has no root (UHera F2)', edits: [["  for (const s of [...parts.slice(unc ? 2 : 0, -1), '..', '..']) {", "  if (parts.length < 4) return undefined;\n  for (const s of [...parts.slice(unc ? 2 : 0, -1), '..', '..']) {"]],
    killer: 'short', dies: /SHORT RUNNER PATH: ITS REPO'S PICKS ARE READ \(Bash: cd test && node tools\/run-tests\.cjs activity-lag\)/ },
  { file: HJF, name: 'the part-count rule (d4ecf6ad, UHera NIT)', edits: [["  for (const s of [...parts.slice(unc ? 2 : 0, -1), '..', '..']) {", "  const q = parts.filter((p, i) => !(p === '.' && parts.slice(0, i).every((x) => x === '.')));\n  if (q.length < 4) return q.length === 1 ? '../..' : q.length === 2 ? (q[0] === '..' ? '../../..' : '..') : undefined;\n  for (const s of [...parts.slice(unc ? 2 : 0, -1), '..', '..']) {"]],
    killer: 'short', dies: /SHORT RUNNER PATH: ITS REPO'S PICKS ARE READ \(Bash: cd test\/heavy-lock && node \.\.\/tools\/run-tests\.cjs activity-lag\)/ },
  { file: HJF, name: 'a UNC runner path loses its leading pair (Jim NIT)', edits: [["  const unc = parts[0] === '' && parts[1] === '';", '  const unc = false;']],
    killer: 'unc', dies: /UNC RUNNER PATH: THE SHARE IS ITS REPO \(Bash: node \/\/srv\/share\/test\/tools\/run-tests\.cjs het-electron\)/ },
  { file: HJF, name: 'the 20-file suite rule is gone (every pick judged by file)', edits: [["  if (n >= SUITE_MANY_FILES) return { heavy: true, kind: 'suite'", "  if (false) return { heavy: true, kind: 'suite'"]],
    killer: 'boundary', dies: /BOUNDARY: 20 PICKS ARE THE SUITE/ },
  { file: HJF, name: 'a test file\'s tag is not read at hop 0', edits: [['    if (hop === 0 || test) {\n      if (LIVE_TAG.test(', '    if (test) {\n      if (LIVE_TAG.test(']],
    killer: 'pick', dies: /A TAGGED FILE PICKED IS HEAVY/ },
  { file: null, name: 'quit-sweep.electron loses its tag', strip: 'test/quit-sweep.electron.test.cjs',
    killer: 'census', dies: /CENSUS: EVERY TEST FILE THAT STARTS ELECTRON IS HEAVY ALONE\. Light: test\/quit-sweep\.electron\.test\.cjs\./ },
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, async (tt) => {
      const ms = m.file === null ? { HJ, HK } : m.file === HJF ? { HJ: loadTs.fromText(m.file, mutateText(m.file, m.edits, m.name)), HK } : { HJ, HK: loadTs.fromText(m.file, mutateText(m.file, m.edits, m.name)) };
      await assert.rejects(async () => K[m.killer](ms, tt, m.strip), (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      }, `${m.name}: MUST DIE`);
    });
  }
});
