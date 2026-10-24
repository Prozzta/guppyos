'use strict';
require('./tools/own-job.cjs');

/**
 * MUNDER_DEV=1 isolation helpers (src/main/devIsolation.ts) — pure, no electron.
 * The guard must reject every way a dev build could land on Stable's data:
 * a path equal to, inside, or containing a Stable path; a pipe name equal to
 * Stable's; and it must scrub the env a Stable agent terminal exports.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const iso = loadTs(path.resolve(__dirname, '../src/main/devIsolation.ts'));

const WIN = 'win32';
const STABLE_HIVE = 'C:\\Dunder\\hive';
const STABLE_USERDATA = 'C:\\Users\\FiercePC\\AppData\\Roaming\\munder-difflin';

test('DEV_ISOLATION is a boolean derived from MUNDER_DEV', () => {
  assert.equal(typeof iso.DEV_ISOLATION, 'boolean');
});

test('G1 trial build compiles a force-dev gate while a normal build keeps it false', () => {
  const vite = fs.readFileSync(path.resolve(__dirname, '../electron.vite.config.ts'), 'utf8');
  const source = fs.readFileSync(path.resolve(__dirname, '../src/main/devIsolation.ts'), 'utf8');
  const trialBuilder = fs.readFileSync(path.resolve(__dirname, '../electron-builder.trial.yml'), 'utf8');
  assert.match(vite, /__FORCE_DEV__:\s*JSON\.stringify\(process\.env\.GUPPY_TRIAL_BUILD === '1'\)/);
  assert.match(source, /process\.env\.MUNDER_DEV === '1' \|\| FORCE_DEV_BUILD/);
  assert.match(vite, /__LAYERB_SEAMS__:\s*JSON\.stringify\(process\.env\.GUPPY_TRIAL_BUILD !== '1' && process\.env\.MUNDER_LAYERB_SEAMS === '1'\)/);
  assert.match(trialBuilder, /^productName: Guppy 1\.1\.85 Trial$/m);
  assert.match(trialBuilder, /^appId: in\.munderdiffl\.app\.trial$/m);
});

test('G3 force-dev trial root is distinct from the shared MUNDER_DEV root and passes the path guard', () => {
  const trial = 'C:\\Dunder\\GuppyTrialData';
  assert.equal(iso.fixedDevDataRoot(WIN, true), trial);
  assert.equal(iso.fixedDevDataRoot(WIN, false), 'C:\\Dunder\\MunderDevData');
  const forbidden = [STABLE_HIVE, STABLE_USERDATA, 'C:\\Dunder\\MunderDevData'];
  assert.deepEqual(iso.checkIsolation(iso.devPaths(trial, WIN), forbidden, WIN), []);
});

test('G2 updater and G4 login-item IPC explicitly refuse under DEV_ISOLATION', () => {
  const updater = fs.readFileSync(path.resolve(__dirname, '../src/main/updater.ts'), 'utf8');
  const index = fs.readFileSync(path.resolve(__dirname, '../src/main/index.ts'), 'utf8');
  const loginItem = fs.readFileSync(path.resolve(__dirname, '../src/main/loginItem.ts'), 'utf8');
  assert.match(updater, /import \{ DEV_HIDDEN, DEV_ISOLATION \} from '\.\/devIsolation';/);
  assert.match(updater, /export function initAutoUpdater[\s\S]{0,900}if \(DEV_ISOLATION\)[\s\S]{0,900}ipcMain\.handle\('update:checkNow', refused\)[\s\S]{0,300}ipcMain\.handle\('update:download', refused\)[\s\S]{0,300}ipcMain\.handle\('update:simulate', refused\)[\s\S]{0,300}ipcMain\.handle\('update:openRelease', refused\)[\s\S]{0,300}return;/);
  assert.match(index, /import \{ setLoginItem \} from '\.\/loginItem';/);
  assert.match(index, /ipcMain\.handle\('app:setLoginItem',[\s\S]{0,300}return setLoginItem\(enabled\);/);
  assert.match(loginItem, /if \(DEV_ISOLATION\) return false;[\s\S]{0,300}app\.setLoginItemSettings/);
});

test('devDataRoot is FIXED on win32 and ignores the environment (no MUNDER_DEV_DATA override)', () => {
  assert.equal(iso.devDataRoot(WIN), 'C:\\Dunder\\MunderDevData');
  const saved = process.env.MUNDER_DEV_DATA;
  process.env.MUNDER_DEV_DATA = 'D:\\x\\devdata';
  try { assert.equal(iso.devDataRoot(WIN), 'C:\\Dunder\\MunderDevData'); }
  finally { if (saved === undefined) delete process.env.MUNDER_DEV_DATA; else process.env.MUNDER_DEV_DATA = saved; }
  assert.equal(iso.devDataRoot('linux').endsWith('MunderDevData'), true);
  // The removed MUNDER_DEV_DATA stays ignored even under MUNDER_DEV=1.
  assert.equal(iso.devDataRoot(WIN, { MUNDER_DEV_DATA: 'D:\\x\\devdata' }, true), 'C:\\Dunder\\MunderDevData');
});

test('devDataRoot contract (layer b): FIXED unless the validated MUNDER_DEV_ROOT is present UNDER MUNDER_DEV', () => {
  const FIXED = 'C:\\Dunder\\MunderDevData';
  assert.equal(iso.fixedDevDataRoot(WIN), FIXED);
  // Not under MUNDER_DEV: the override is ignored, whatever it says.
  assert.equal(iso.devDataRoot(WIN, { MUNDER_DEV_ROOT: 'D:\\sandbox\\run1' }, false), FIXED);
  // Under MUNDER_DEV, unset or blank: still the fixed root.
  assert.equal(iso.devDataRoot(WIN, {}, true), FIXED);
  assert.equal(iso.devDataRoot(WIN, { MUNDER_DEV_ROOT: '   ' }, true), FIXED);
  // Under MUNDER_DEV, a valid absolute path: that root, normalised.
  assert.equal(iso.devDataRoot(WIN, { MUNDER_DEV_ROOT: 'D:\\sandbox\\run1\\' }, true), 'D:\\sandbox\\run1');
  // Under MUNDER_DEV, an invalid one THROWS rather than falling back to the fixed root.
  assert.throws(() => iso.devDataRoot(WIN, { MUNDER_DEV_ROOT: 'relative\\dir' }, true), /refusing MUNDER_DEV_ROOT/);
  assert.throws(() => iso.devDataRoot(WIN, { MUNDER_DEV_ROOT: 'C:\\Dunder\\hive\\x' }, true), /refusing MUNDER_DEV_ROOT/);
});

test('devPaths derive hive/palace/worktrees/userData under the root with a dev pipe marker', () => {
  const p = iso.devPaths('C:\\Dunder\\MunderDevData', WIN);
  assert.equal(p.userData, 'C:\\Dunder\\MunderDevData\\userData');
  assert.equal(p.harnessHome, 'C:\\Dunder\\MunderDevData');
  assert.equal(p.hiveRoot, 'C:\\Dunder\\MunderDevData\\hive');
  assert.equal(p.palace, 'C:\\Dunder\\MunderDevData\\palace');
  assert.equal(p.worktrees, 'C:\\Dunder\\MunderDevData\\worktrees');
  assert.match(p.pipeName, /^\\\\\.\\pipe\\munder-difflin-dev-[0-9a-f]{12}$/);
});

test('hookPipeId reproduces the live Stable pipe id for C:\\Dunder\\hive', () => {
  // Observed on the running Stable v0.4.5: \\.\pipe\munder-difflin-23c0d031569a
  assert.equal(iso.hookPipeId(STABLE_HIVE), '23c0d031569a');
  assert.equal(iso.hookPipeName(STABLE_HIVE, false, WIN), '\\\\.\\pipe\\munder-difflin-23c0d031569a');
});

test('isInside: equal, nested, case-insensitive on win32, and not a prefix false-positive', () => {
  assert.equal(iso.isInside('C:\\Dunder\\hive', 'C:\\Dunder\\hive', WIN), true);
  assert.equal(iso.isInside('c:\\dunder\\HIVE\\agents\\x', 'C:\\Dunder\\hive\\', WIN), true);
  assert.equal(iso.isInside('C:\\Dunder\\hive2', 'C:\\Dunder\\hive', WIN), false);
  assert.equal(iso.isInside('C:\\Dunder\\MunderDevData\\hive', 'C:\\Dunder\\hive', WIN), false);
});

test('canonicalPath/isInside: a differently-spelled Stable hive is still the Stable hive (realpath, not string)', (t) => {
  if (process.platform !== 'win32') { t.skip('needs the real C:\\Dunder\\hive'); return; }
  const fs = require('node:fs');
  if (!fs.existsSync(STABLE_HIVE)) { t.skip('C:\\Dunder\\hive not present on this host'); return; }
  // Forward slashes, lower case, trailing slash and a dot-segment all resolve to
  // the same directory and must be caught even though each has a different
  // sha1-derived pipe id.
  for (const spelling of ['C:/Dunder/hive', 'c:\\dunder\\HIVE', 'C:\\Dunder\\hive\\', 'C:\\Dunder\\.\\hive', 'C:\\Dunder\\MunderDevData\\..\\hive']) {
    assert.equal(iso.isInside(spelling, STABLE_HIVE, WIN), true, spelling);
    assert.notEqual(iso.hookPipeId(spelling), iso.hookPipeId(STABLE_HIVE), `${spelling} has a different pipe id`);
    const p = iso.devPaths('C:\\Dunder\\MunderDevData', WIN);
    p.hiveRoot = spelling;
    const v = iso.checkIsolation(p, [STABLE_HIVE], WIN);
    assert.ok(v.some((s) => s.startsWith('hiveRoot')), `${spelling}: ${v.join('|')}`);
  }
  // A not-yet-existing dev root canonicalises via its nearest existing ancestor.
  assert.equal(iso.canonicalPath('C:\\Dunder\\does-not-exist-zz\\hive', WIN), 'c:\\dunder\\does-not-exist-zz\\hive');
});

test('stableForbiddenPaths: literals + default userData + paths under Stable harnessHome, deduped', () => {
  const f = iso.stableForbiddenPaths({ defaultUserData: STABLE_USERDATA, stableHarnessHome: 'C:\\Dunder', platform: WIN });
  assert.ok(f.includes(STABLE_HIVE));
  assert.ok(f.includes('C:\\Dunder\\palace'));
  assert.ok(f.includes(STABLE_USERDATA));
  assert.ok(f.includes('C:\\Dunder\\roster.json'));
  assert.ok(f.includes('C:\\Dunder\\hallways.json'));
  assert.ok(f.includes('C:\\Dunder\\tunnels.json'));
  assert.equal(new Set(f.map((p) => p.toLowerCase())).size, f.length, 'deduped');
});

test('checkIsolation: the intended dev layout passes against the real Stable set', () => {
  const forbidden = iso.stableForbiddenPaths({ defaultUserData: STABLE_USERDATA, stableHarnessHome: 'C:\\Dunder', platform: WIN });
  const v = iso.checkIsolation(iso.devPaths('C:\\Dunder\\MunderDevData', WIN), forbidden, WIN);
  assert.deepEqual(v, []);
});

test('checkIsolation: rejects a hive root inside Stable hive', () => {
  const p = iso.devPaths('C:\\Dunder\\MunderDevData', WIN);
  p.hiveRoot = 'C:\\Dunder\\hive';
  const v = iso.checkIsolation(p, [STABLE_HIVE], WIN);
  assert.ok(v.some((s) => s.startsWith('hiveRoot')), v.join('\n'));
});

test('checkIsolation: rejects a harnessHome that CONTAINS Stable hive (C:\\Dunder)', () => {
  const p = iso.devPaths('C:\\Dunder', WIN);
  const v = iso.checkIsolation(p, [STABLE_HIVE], WIN);
  assert.ok(v.some((s) => /harnessHome .* contains Stable path/.test(s)), v.join('\n'));
});

test('checkIsolation: rejects userData equal to Stable userData', () => {
  const p = iso.devPaths('C:\\Dunder\\MunderDevData', WIN);
  p.userData = STABLE_USERDATA;
  const v = iso.checkIsolation(p, [STABLE_USERDATA], WIN);
  assert.ok(v.some((s) => s.startsWith('userData')), v.join('\n'));
});

test('checkIsolation: rejects a pipe equal to Stable\'s and one without the dev marker', () => {
  const p = iso.devPaths('C:\\Dunder\\MunderDevData', WIN);
  p.pipeName = '\\\\.\\pipe\\munder-difflin-23c0d031569a';
  const v = iso.checkIsolation(p, [STABLE_HIVE], WIN);
  assert.ok(v.some((s) => /equals Stable's pipe/.test(s)), v.join('\n'));
  assert.ok(v.some((s) => /lacks the dev marker/.test(s)), v.join('\n'));
});

test('scrubInheritedEnv removes exactly the Stable identity keys and reports them', () => {
  const env = { PATH: 'keep', UNRELATED_MODEL: 'minilm', CLAUDE_CONFIG_DIR: 'keep-too',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1', OTEL_METRICS_EXPORTER: 'otlp' };
  for (const k of iso.STABLE_ENV_KEYS) env[k] = 'stable-value';
  // Every key Dwight's audit listed must be in the scrub set.
  for (const k of ['KG_ROOT', 'KG_CLI', 'KG_CORE', 'MD_BROKER_URL', 'MD_BROKER_TOKEN', 'HIVE_PROXY_SESSION',
    'OPENAI_BASE_URL', 'CRUSH_PROXY_BASE_URL', 'CLAUDE_CODE_ENABLE_TELEMETRY', 'OPENCODE_CONFIG_CONTENT',
    'HIVE_ROOT', 'HIVE_SOCK', 'HIVE_NODE', 'AGENT_ID', 'AGENT_DIR', 'AGENT_NAME', 'MEMORY_TOKEN', 'MUNDER_MEMORY_URL', 'MUNDER_HIVE_ROOT']) {
    assert.ok(iso.STABLE_ENV_KEYS.includes(k), `${k} must be scrubbed`);
  }
  const removed = iso.scrubInheritedEnv(env);
  assert.deepEqual(removed.sort(), [...iso.STABLE_ENV_KEYS, 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_METRICS_EXPORTER'].sort());
  assert.equal(env.PATH, 'keep');
  assert.equal(env.UNRELATED_MODEL, 'minilm');
  assert.equal(env.CLAUDE_CONFIG_DIR, 'keep-too');
  for (const k of iso.STABLE_ENV_KEYS) assert.equal(k in env, false);
  assert.equal(Object.keys(env).some((k) => k.startsWith('OTEL_')), false);
});

// SCRUB1: the auth env vars Codex reads (codex-cli 0.157.1 `codex login status`
// lists exactly OPENAI_API_KEY, CODEX_API_KEY, CODEX_ACCESS_TOKEN as "auth env
// vars present"). Inherited from a Stable terminal they would sign a dev agent in
// with the Human's key instead of its own isolated CODEX_HOME login.
const CODEX_AUTH_KEYS = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'];

test('SCRUB1: the Codex auth env vars are in the scrub set', () => {
  for (const k of CODEX_AUTH_KEYS) assert.ok(iso.STABLE_ENV_KEYS.includes(k), `${k} must be scrubbed`);
});

test('SCRUB1: an agent spawned by a scrubbed dev process does not carry the Codex auth vars', () => {
  const { spawnSync } = require('node:child_process');
  // The child stands in for the dev main process: it scrubs its own process.env as
  // index.ts bootstrap does, builds an agent env with buildPtyEnv and spawns from it.
  // On win32 one key is set in lower case: process.env lookups are case-insensitive
  // there, so the scrub must still take it.
  const child = `
    const loadTs = require(${JSON.stringify(path.resolve(__dirname, 'load-ts.cjs'))});
    const iso = loadTs(${JSON.stringify(path.resolve(__dirname, '../src/main/devIsolation.ts'))});
    const { buildPtyEnv } = loadTs(${JSON.stringify(path.resolve(__dirname, '../src/main/ptyEnv.ts'))});
    iso.scrubInheritedEnv(process.env);
    const env = buildPtyEnv(process.env, process.env.PATH || '', {});
    // Guppy's own BYOK key is materialized per agent (agentEnv layer) and must survive.
    const byok = buildPtyEnv(process.env, process.env.PATH || '', { OPENAI_API_KEY: 'byok-from-broker' });
    const r = require('node:child_process').spawnSync(process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env)))'], { env, encoding: 'utf8' });
    process.stdout.write(JSON.stringify({ keys: JSON.parse(r.stdout), byok: byok.OPENAI_API_KEY }));`;
  const env = { ...process.env, SCRUB1_CONTROL: 'kept' };
  for (const k of CODEX_AUTH_KEYS) env[k] = 'sk-stable-test-value';
  if (process.platform === 'win32') { delete env.CODEX_ACCESS_TOKEN; env.codex_access_token = 'sk-stable-test-value'; }
  const r = spawnSync(process.execPath, ['-e', child], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.byok, 'byok-from-broker', 'a per-agent BYOK key is not scrubbed');
  const keys = out.keys.map((k) => k.toUpperCase());
  assert.ok(keys.includes('SCRUB1_CONTROL'), 'the grandchild inherits ordinary env');
  for (const k of CODEX_AUTH_KEYS) assert.equal(keys.includes(k), false, `${k} reached the spawned agent`);
});

// DEV-ISO-HOOK-TOKEN-198: the hive ids and secrets a Stable agent shell exports. A dev main process
// started from that shell scrubs them all; what it keeps is not Stable's identity (a sidecar's API
// word, a test run id the dev lock does not know, the dev's own knobs).
const HIVE_SCRUB = ['HIVE_HOOK_TOKEN', 'MUNDER_WAKE_INCARNATION', 'HIVE_SOCK', 'HIVE_LEDGER_URL', 'HIVE_TERM_URL', 'HIVE_ROOT',
  'HIVE_NODE', 'HIVE_AUTO_APPROVE', 'AGENT_ID', 'AGENT_DIR', 'AGENT_NAME', 'MEMORY_TOKEN', 'MUNDER_MEMORY_URL', 'MUNDER_HIVE_ROOT',
  'MD_BROKER_URL', 'MD_BROKER_TOKEN', 'HIVE_PROXY_SESSION'];
const HIVE_KEEP = ['HIVE_PROXY_API', 'GUPPY_TEST_RUN', 'MUNDER_DEV', 'MUNDER_DEV_ROOT', 'MUNDER_DEV_DATA'];

const KT = {
  // A dev env built from a Stable agent env carries no hook token (nor any other hive id or secret).
  hookToken(I = iso) {
    const env = { PATH: 'keep' };
    for (const k of [...HIVE_SCRUB, ...HIVE_KEEP]) env[k] = 'stable-value';
    I.scrubInheritedEnv(env);
    assert.equal('HIVE_HOOK_TOKEN' in env, false, 'A DEV ENV HAS NO STABLE HOOK TOKEN');
    for (const k of HIVE_SCRUB) assert.equal(k in env, false, `${k} must not reach a dev build`);
    for (const k of HIVE_KEEP) assert.equal(env[k], 'stable-value', `${k} is kept`);
  }
};

test('DEV-ISO-HOOK-TOKEN-198: a dev env built from a Stable agent env has no hook token, no hive id or secret', () => KT.hookToken());

test('DEV-ISO-HOOK-TOKEN-198: an agent spawned by a scrubbed dev process does not carry the Stable hook token', () => {
  const { spawnSync } = require('node:child_process');
  // As SCRUB1: the child stands in for the dev main process (bootstrap scrub, then an agent env).
  const child = `
    const loadTs = require(${JSON.stringify(path.resolve(__dirname, 'load-ts.cjs'))});
    const iso = loadTs(${JSON.stringify(path.resolve(__dirname, '../src/main/devIsolation.ts'))});
    const { buildPtyEnv } = loadTs(${JSON.stringify(path.resolve(__dirname, '../src/main/ptyEnv.ts'))});
    iso.scrubInheritedEnv(process.env);
    const env = buildPtyEnv(process.env, process.env.PATH || '', {});
    process.stdout.write(JSON.stringify(Object.keys(env).map((k) => k.toUpperCase())));`;
  const env = { ...process.env, HIVE_SOCK: '\\\\.\\pipe\\munder-hive', MUNDER_WAKE_INCARNATION: 'w1' };
  // On win32 the token is set in lower case: process.env lookups are case-insensitive there.
  if (process.platform === 'win32') { delete env.HIVE_HOOK_TOKEN; env.hive_hook_token = 'ab'.repeat(16); } else env.HIVE_HOOK_TOKEN = 'ab'.repeat(16);
  const r = spawnSync(process.execPath, ['-e', child], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const keys = JSON.parse(r.stdout);
  for (const k of ['HIVE_HOOK_TOKEN', 'HIVE_SOCK', 'MUNDER_WAKE_INCARNATION']) assert.equal(keys.includes(k), false, `${k} reached the spawned agent`);
});

test('DEV-ISO-HOOK-TOKEN-198 MUTANT CENSUS: dropping a scrub key dies at its assertion', async (t) => {
  const { readSource } = require('./read-source.cjs');
  const rel = 'src/main/devIsolation.ts';
  for (const [name, from, dies] of [
    ['the hook token is not scrubbed', "  'HIVE_HOOK_TOKEN',\n", /A DEV ENV HAS NO STABLE HOOK TOKEN/],
    ['the wake incarnation is not scrubbed', "  'MUNDER_WAKE_INCARNATION',\n", /MUNDER_WAKE_INCARNATION must not reach a dev build/]
  ]) {
    await t.test(`mutant: ${name}`, () => {
      const text = readSource(rel);
      assert.equal(text.split(from).length - 1, 1, `mutant ${name}: target must match exactly once`);
      const I = loadTs.fromText(rel, text.replace(from, () => ''));
      assert.throws(() => KT.hookToken(I), (e) => { assert.match(String(e && e.message), dies, `${name}: died for the wrong reason: ${e && e.message}`); return true; });
    });
  }
});

test('devWindowTitle: marks DEV only when isolation is on', () => {
  assert.equal(iso.devWindowTitle('Guppy', false), 'Guppy');
  assert.equal(iso.devWindowTitle('Guppy', true), 'Guppy DEV');
  assert.equal(iso.devWindowTitle('Guppy — Floor', true), 'Guppy DEV — Floor');
});
