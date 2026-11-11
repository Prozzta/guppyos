'use strict';
/**
 * GUPPY-BUILD-PREREQS: the opt-in "Build from source" group of Settings → Prerequisites.
 * Catalog rows per platform, the probes (Node major + PGO, node-gyp's Python order, vswhere per
 * VS component), the install text, and the wiring (IPC, preload, panel). The existing rows and
 * the essential set must not move.
 */
require('./tools/own-job.cjs');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const REPO = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const C = loadTs('src/shared/toolCatalog.ts');
const P = loadTs('src/main/buildPrereqs.ts');

const PF86 = 'C:\\Program Files (x86)';
const VSWHERE = `${PF86}\\Microsoft Visual Studio\\Installer\\vswhere.exe`;
const BT = `${PF86}\\Microsoft Visual Studio\\2022\\BuildTools`;
const LOCAL = 'C:\\Users\\u\\AppData\\Local';
const PY312 = `${LOCAL}\\Programs\\Python\\Python312\\python.exe`;
const PY311 = `${LOCAL}\\Programs\\Python\\Python311\\python.exe`;
const WIN_ENV = { 'ProgramFiles(x86)': PF86, ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: LOCAL, SystemDrive: 'C:' };

/** A fake machine. `node`: [version, pgo, execPath] or null; `pythons`: { file: version };
 *  `components`: VS component ids installed (in BT); `files`: paths that exist. */
function machine({ platform = 'win32', env = WIN_ENV, node = ['24.22.2', false, 'C:\\node24\\node.exe'], pythons = {}, components = [], files = [], vswhere = true, timeouts = [] } = {}) {
  const calls = [];
  const exists = (p) => files.includes(p) || (vswhere && p === VSWHERE) || Object.keys(pythons).includes(p);
  const exec = async (file, args) => {
    calls.push([file, ...args]);
    if (timeouts.includes(file)) return { ok: false, stdout: '', timedOut: true };
    if (file === 'node') return node ? { ok: true, stdout: JSON.stringify(node) + '\n' } : { ok: false, stdout: '' };
    if (file === VSWHERE) {
      const i = args.indexOf('-requires'), j = args.indexOf('-property');
      const ids = i < 0 ? [] : args.slice(i + 1, j);
      return { ok: true, stdout: ids.every((id) => components.includes(id)) ? `${BT}\r\n` : '' };
    }
    const key = file === 'py' ? 'py' : file;
    const v = pythons[key];
    if (!v) return { ok: false, stdout: '' };
    const exe = key === 'py' || key === 'python' || key === 'python3' ? (pythons[`${key}:exe`] || `C:\\resolved\\${key}.exe`) : file;
    return { ok: true, stdout: `${exe}\r\n${v}\r\n` };
  };
  return { deps: { platform, env, exists, exec }, calls };
}
const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));
const ALL_VS = [...new Set(Object.values(C.BUILD_VS_REQUIRES).flat())];

test('catalog: Windows has the four build rows, posix only Node and Python; none essential', () => {
  const win = C.buildToolCatalog('win32').map((t) => t.id);
  assert.deepEqual(win, ['build:node', 'build:python', 'build:vs-vctools', 'build:vs-spectre']);
  // Native builds use MSVC v143: npm's node-gyp (10.3+) forces clang 0 on Windows even under the clang-cl built Node 24, so ClangCL is never needed (Jim M1, M1 on GUPPY-NODE-LTS)
  assert.equal(JSON.stringify(C.buildToolCatalog('win32')).includes('Llvm'), false, 'no LLVM/ClangCL row or install line');
  assert.deepEqual(C.buildToolCatalog('linux').map((t) => t.id), ['build:node', 'build:python']);
  assert.deepEqual(C.buildToolCatalog('darwin').map((t) => t.id), ['build:node', 'build:python']);
  for (const t of C.buildToolCatalog('win32')) {
    assert.equal(t.kind, 'build', t.id);
    assert.equal(t.essential, false, t.id);
    assert.ok(t.install.win32.length > 0, `${t.id} has a Windows install command`);
    assert.equal('platforms' in t, false, 'the platform filter does not leak into the row');
  }
});

test('catalog: the existing rows and the essential set are untouched (no build rows in tools:status)', () => {
  const rows = C.toolCatalog();
  assert.equal(rows.some((t) => t.kind === 'build'), false);
  assert.deepEqual(rows.filter((t) => t.essential).map((t) => t.id).sort(), ['engine:claude', 'git']);
  const node = rows.find((t) => t.id === 'node');
  assert.deepEqual(node.install, { posix: '', win32: '' }, 'the runtime Node row keeps deferring to nodeInstall.ts');
});

test('catalog: the install text names the exact winget / VS Installer ids and says it needs admin', () => {
  const w = byId(C.buildToolCatalog('win32'));
  assert.match(w['build:python'].install.win32, /winget install --id Python\.Python\.3\.12 -e/);
  assert.match(w['build:vs-vctools'].install.win32, /Microsoft\.VisualStudio\.2022\.BuildTools.*--add Microsoft\.VisualStudio\.Workload\.VCTools/);
  assert.match(w['build:vs-spectre'].install.win32, /modify --installPath .*--add Microsoft\.VisualStudio\.Component\.VC\.Runtimes\.x86\.x64\.Spectre/);
  for (const id of ['build:vs-vctools', 'build:vs-spectre']) assert.match(w[id].note, /admin prompt/, id);
  assert.match(C.BUILD_GROUP.why, /better-sqlite3/);
  assert.match(C.BUILD_GROUP.why, /node-pty/);
  assert.match(C.BUILD_GROUP.posixNote, /xcode-select --install/);
  assert.match(C.BUILD_GROUP.posixNote, /build-essential/);
});

test('the Node pin matches .nvmrc, and every CI workflow reads .nvmrc', () => {
  assert.equal(read('.nvmrc').trim(), String(C.BUILD_NODE_MAJOR));
  assert.equal(C.BUILD_NODE_MAJOR, 24);
  for (const wf of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
    const text = read(wf);
    const setups = (text.match(/uses: actions\/setup-node@/g) || []).length;
    assert.ok(setups > 0, `${wf} sets up Node`);
    assert.equal((text.match(/node-version-file: \.nvmrc/g) || []).length, setups, `${wf}: every setup-node reads .nvmrc`);
    assert.equal(/node-version:/.test(text), false, `${wf}: no second, literal Node pin`);
  }
});

test('node: the pinned major is ready; another major or a PGO build warns with the install text', async () => {
  let r = byId(await P.buildPrereqStatus(machine({ components: ALL_VS }).deps))['build:node'];
  assert.equal(r.found, true); assert.equal(r.warn, undefined); assert.equal(r.detail, 'v24.22.2');
  assert.equal(r.path, 'C:\\node24\\node.exe');
  r = byId(await P.buildPrereqStatus(machine({ node: ['26.1.0', false, 'C:\\n\\node.exe'] }).deps))['build:node'];
  assert.equal(r.found, true); assert.match(r.warn, /26\.1\.0.*needs Node 24/); assert.match(r.installCommand, /nvm install 24/);
  r = byId(await P.buildPrereqStatus(machine({ node: ['24.22.2', true, 'C:\\n\\node.exe'] }).deps))['build:node'];
  assert.match(r.warn, /PGO \(enable_pgo_use\)/);
  r = byId(await P.buildPrereqStatus(machine({ node: null }).deps))['build:node'];
  assert.equal(r.found, false); assert.equal(r.warn, undefined);
  r = byId(await P.buildPrereqStatus(machine({ timeouts: ['node'] }).deps))['build:node'];
  assert.equal(r.found, false); assert.equal(r.unknown, true, 'a timed-out probe is not checked, never missing');
});

test('python: node-gyp order: npm_config_python wins over PATH', async () => {
  const env = { ...WIN_ENV, npm_config_python: PY312 };
  const m = machine({ env, pythons: { [PY312]: '3.12.7', python: '3.13.1' } });
  const r = byId(await P.buildPrereqStatus(m.deps))['build:python'];
  assert.equal(r.found, true); assert.equal(r.warn, undefined); assert.equal(r.path, PY312);
  assert.match(r.detail, /3\.12\.7 \(via npm_config_python\)/);
  assert.equal(m.calls.some((c) => c[0] === 'python'), false, 'stops at the first usable Python, like node-gyp');
});

test('python: a 3.12 node-gyp will not find (Python312 is not in its default list) gives the npm_config_python fix', async () => {
  const r = byId(await P.buildPrereqStatus(machine({ files: [PY312], pythons: { [PY312]: '3.12.7' } }).deps))['build:python'];
  assert.equal(r.found, true);
  assert.match(r.warn, /node-gyp will not find it/);
  assert.match(r.warn, /restart Guppy/, 'setx reaches only new processes; the re-check reads Guppy\'s own env (Jim N1)');
  assert.equal(r.installCommand, `setx npm_config_python "${PY312}"`);
});

test('python: node-gyp picks another working 3.x: ready, shown as information (no warn)', async () => {
  const m1 = machine({ files: [PY312], pythons: { py: '3.13.1', 'py:exe': 'C:\\Py313\\python.exe', [PY312]: '3.12.7' } });
  let r = byId(await P.buildPrereqStatus(m1.deps))['build:python'];
  assert.equal(r.found, true); assert.equal(r.path, 'C:\\Py313\\python.exe');
  assert.equal(r.warn, undefined, 'node-gyp accepts any 3.6+, so the build works (Jim N2)');
  assert.equal(r.detail, '3.13.1 (via the py launcher)');
  assert.match(C.buildToolCatalog('win32').find((t) => t.id === 'build:python').why, /release workflow builds with 3\.11/, 'the panel must not contradict release.yml');
  assert.equal(m1.calls.some((c) => c[0] === PY312), false, 'a working pick needs no 3.12 search');
  // node-gyp's own default list (3.11) counts as a pick
  r = byId(await P.buildPrereqStatus(machine({ pythons: { [PY311]: '3.11.9' } }).deps))['build:python'];
  assert.equal(r.path, PY311); assert.equal(r.warn, undefined); assert.match(r.detail, /3\.11\.9/);
});

test('python: none at all is missing with the winget command; posix never tries py or Windows paths', async () => {
  let r = byId(await P.buildPrereqStatus(machine().deps))['build:python'];
  assert.equal(r.found, false); assert.match(r.installCommand, /winget install --id Python\.Python\.3\.12 -e/);
  const m = machine({ platform: 'linux', env: {}, pythons: { python3: '3.12.3', 'python3:exe': '/usr/bin/python3.12' } });
  const rows = await P.buildPrereqStatus(m.deps);
  assert.deepEqual(rows.map((t) => t.id), ['build:node', 'build:python']);
  r = byId(rows)['build:python'];
  assert.equal(r.found, true); assert.equal(r.path, '/usr/bin/python3.12'); assert.equal(r.warn, undefined);
  assert.equal(m.calls.some((c) => c[0] === 'py' || c[0] === VSWHERE), false);
});

test('vs: each row asks vswhere -products * for VS 2022 with its own component ids', async () => {
  const m = machine({ components: ['Microsoft.VisualStudio.Component.VC.Tools.x86.x64'] });
  const r = byId(await P.buildPrereqStatus(m.deps));
  assert.equal(r['build:vs-vctools'].found, true); assert.equal(r['build:vs-vctools'].path, BT);
  assert.equal(r['build:vs-spectre'].found, false);
  const vs = m.calls.filter((c) => c[0] === VSWHERE);
  for (const c of vs) {
    assert.deepEqual(c.slice(1, 5), ['-products', '*', '-version', '[17.0,18.0)'], 'Build Tools are only listed with -products *');
  }
  assert.ok(vs.some((c) => c.includes('Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre')));
  // the modify line targets the found install, through the real installer path
  assert.equal(r['build:vs-spectre'].installCommand,
    `"${PF86}\\Microsoft Visual Studio\\Installer\\setup.exe" modify --installPath "${BT}" --add Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre --passive --norestart`);
});

test('vs: everything installed is all ready; no vswhere means not found with the placeholders filled by defaults', async () => {
  let r = byId(await P.buildPrereqStatus(machine({ components: ALL_VS }).deps));
  for (const id of ['build:vs-vctools', 'build:vs-spectre']) assert.equal(r[id].found, true, id);
  const m = machine({ vswhere: false });
  r = byId(await P.buildPrereqStatus(m.deps));
  for (const id of ['build:vs-vctools', 'build:vs-spectre']) assert.equal(r[id].found, false, id);
  assert.equal(m.calls.some((c) => c[0] === VSWHERE), false, 'no vswhere, no spawn');
  assert.ok(r['build:vs-spectre'].installCommand.includes(`--installPath "${C.VS_PATH_DEFAULT}"`));
  assert.equal(/\{vs(Setup|Path)\}/.test(r['build:vs-spectre'].installCommand), false, 'no token left in the shown command');
  r = byId(await P.buildPrereqStatus(machine({ timeouts: [VSWHERE] }).deps));
  assert.equal(r['build:vs-spectre'].unknown, true);
});

test('a probe that throws is a row, not a crash', async () => {
  const deps = { ...machine().deps, exec: async () => { throw new Error('boom'); } };
  const rows = await P.buildPrereqStatus(deps);
  assert.equal(rows.length, 4);
  for (const r of rows) assert.equal(r.found, false, r.id);
});

test('wiring: IPC handler, preload bridge, opt-in panel section, no install from the app', () => {
  const main = read('src/main/index.ts');
  assert.match(main, /ipcMain\.handle\('tools:buildStatus', async \(\): Promise<ToolStatus\[\]> => buildPrereqStatus\(hostBuildProbeDeps\(\)\)\);/);
  // the child glue lives in buildPrereqs.ts: index.ts gains no execFile of its own
  assert.equal(/execFile\(/.test(main.slice(main.indexOf("ipcMain.handle('tools:buildStatus'"), main.indexOf('// ─── IPC: semantic memory'))), false);
  assert.match(read('src/preload/index.ts'), /toolsBuildStatus: \(\): Promise<ToolStatus\[\]> => ipcRenderer\.invoke\('tools:buildStatus'\)/);
  const panel = read('src/renderer/src/components/SetupPanel.tsx');
  assert.match(panel, /<BuildFromSourceSection \/>/);
  // opt-in: the section has no effect that probes on mount; only the button calls the IPC
  const section = panel.slice(panel.indexOf('function BuildFromSourceSection'), panel.indexOf('export function SetupPanel'));
  assert.equal(/useEffect/.test(section), false, 'nothing is probed until the user asks');
  assert.match(section, /window\.cth\.toolsBuildStatus\(\)/);
});

test('the probes only ever spawn node, a Python and vswhere (never an installer)', async () => {
  const m = machine({ env: { ...WIN_ENV, PYTHON: PY311 }, files: [PY312], pythons: { [PY311]: '3.11.9', [PY312]: '3.12.7' } });
  await P.buildPrereqStatus(m.deps);
  const spawned = new Set(m.calls.map((c) => c[0]));
  for (const f of spawned) assert.ok(['node', 'py', 'python', 'python3', VSWHERE, PY311, PY312].includes(f), f);
  assert.equal(m.calls.some((c) => c.some((a) => /winget|setup\.exe|modify/.test(a))), false);
});
