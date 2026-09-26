'use strict';

/**
 * MEMPALACE-REMOVAL (1.1.59; the Human 2026-09-26 22:16Z: "remove mempalace altogether").
 * The native memory engine is the only memory. Design: agents/andy-mtuk4y4x/MEMPALACE-REMOVAL-DESIGN.md
 * (approved by god with decisions D1-D5; Jim's must-haves M1, M2).
 *
 * The behavioural pieces live beside their modules (native-memory.test.cjs: wiring, shim,
 * validation); this file pins the app-level wiring in index.ts / hive.ts.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');
const INDEX = read('src/main/index.ts');
const HIVE = read('src/main/hive.ts');
const between = (src, a, b) => { const i = src.indexOf(a); assert.ok(i >= 0, a); const j = src.indexOf(b, i + a.length); assert.ok(j > i, b); return src.slice(i, j); };

test('(a) the memory engine is on by default: its switch is Settings\' semantic memory, not a mode file', () => {
  assert.match(INDEX, /enabled: \(\) => readConfig\(\)\.semanticMemory !== false,/);
  for (const f of ['src/main/nativeMemory/mainWiring.ts', 'src/main/nativeMemory/service.ts', 'src/main/nativeMemory/worker.ts', 'resources/mempalace-shim.cjs']) {
    const code = read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.doesNotMatch(code, /memory-engine\.json|MODE_FILE|parseMode|fallback-legacy|MUNDER_LEGACY_MEMPALACE|legacyBin/, f);
  }
});

test('(a) Jim M2, fail closed: the prompt\'s memory line follows the spawn\'s memory env (shim first on PATH), decided BEFORE the prompt is built', () => {
  const spawn = between(INDEX, 'const mem = nativeMemory.spawnEnv(opts.hive.id);', 'catch (e) {');
  assert.match(spawn, /semanticMemory: mem !== null,/);
  // The same `mem` feeds the prompt gate and, unconditionally, the final env (Jim R1 / mutant M2b:
  // no branch around the merge; withMemoryPath itself decides, and is tested behaviourally below).
  const gate = spawn.indexOf('semanticMemory: mem !== null');
  const merge = spawn.indexOf('opts.env = withMemoryPath(opts.env as Record<string, string | undefined>, mem, process.env)');
  assert.ok(gate > 0 && merge > gate, 'the prompt gate and the env come from the same decision');
  assert.doesNotMatch(spawn.slice(merge - 200, merge), /if \(/, 'the merge is not skipped behind a condition');
  assert.doesNotMatch(INDEX, /semanticMemory: memory\.active\(\)/, 'no longer gated on a legacy binary');
});

test('(a) Jim R1 (M2b): withMemoryPath puts the shim FIRST, reuses a Windows `Path` key (no second PATH), and leaves env untouched without memory', () => {
  const { withMemoryPath } = require('./load-ts.cjs')('src/main/nativeMemory/mainWiring.ts');
  const d = path.delimiter;
  const mem = { env: { MEMORY_TOKEN: 't'.repeat(32), MUNDER_HIVE_ROOT: 'H' }, shimDir: 'S' };
  const win = withMemoryPath({ Path: `A${d}B`, X: '1' }, mem, { PATH: 'IGNORED' });
  assert.deepEqual(win, { Path: `S${d}A${d}B`, X: '1', MEMORY_TOKEN: 't'.repeat(32), MUNDER_HIVE_ROOT: 'H' });
  assert.equal(Object.keys(win).filter((k) => k.toUpperCase() === 'PATH').length, 1, 'exactly one PATH key');
  assert.deepEqual(withMemoryPath({ X: '1' }, mem, { Path: 'P' }), { X: '1', Path: `S${d}P`, MEMORY_TOKEN: 't'.repeat(32), MUNDER_HIVE_ROOT: 'H' }, 'PATH from the process env, under its key');
  assert.equal(withMemoryPath({}, mem, {}).PATH, 'S', 'no PATH anywhere: the shim dir alone');
  // Jim H4: the SAME key in both, so the lookup collides: the env's own PATH wins over the process's.
  assert.equal(withMemoryPath({ Path: 'A' }, mem, { Path: 'B' }).Path, `S${d}A`);
  const env = { Path: 'A', X: '1' };
  assert.equal(withMemoryPath(env, null, { PATH: 'P' }), env, 'no memory: the env is returned untouched');
  assert.equal(env.Path, 'A');
});

test('(a) agent-facing text says "the memory engine", keeps the `mempalace` command, and names no MEMPALACE_* variable', () => {
  const line = between(HIVE, 'const memoryLine = semanticMemory', ": '';");
  assert.match(line, /built-in memory engine/);
  assert.match(line, /mempalace search/);
  assert.doesNotMatch(line, /MEMPALACE_PALACE_PATH|mined into the palace/);
  const proto = between(HIVE, '## Semantic memory', '// ─── cth-hook shim');
  assert.doesNotMatch(proto, /MEMPALACE_PALACE_PATH|optional — when|mined into the palace/);
  assert.match(proto, /memory engine/);
});

// ── (b) the Human-facing memory paths: the memory engine, and the old data ───────────────────

const os = require('node:os');
const loadTs = require('./load-ts.cjs');
const { legacyPalaceInfo, deleteLegacyPalace, realFs } = loadTs('src/main/legacyPalace.ts');

function home(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mprm-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return root;
}

test('(b) IPC: search / wake-up / status go to the memory engine as main-internal queries; there is no mine step', () => {
  const ipc = between(INDEX, "// ─── IPC: semantic memory (the memory engine)", "ipcMain.handle('memory:deleteLegacyData'");
  assert.match(ipc, /nativeMemory\.query\('status'\)/);
  assert.match(ipc, /nativeMemory\.query\('search', \{ query,/);
  assert.match(ipc, /nativeMemory\.query\('wake-up'/);
  assert.doesNotMatch(ipc, /memory\.(search|wakeUp|refresh|mineNow)\(/);
  assert.doesNotMatch(INDEX, /'hive:mineNow'/);
  assert.doesNotMatch(read('src/preload/index.ts'), /mineNow/);
});

test('(b) D2: the old-data delete runs only after a native confirm, and is logged', () => {
  const del = between(INDEX, "ipcMain.handle('memory:deleteLegacyData'", '\n});\n');
  const confirm = del.indexOf('dialog.showMessageBox');
  const act = del.indexOf('deleteLegacyPalace(home)');
  assert.ok(confirm > 0 && act > confirm, 'confirm first');
  assert.match(del, /if \(choice\.response !== 0\) return/);
  assert.match(del, /kind: 'legacy-palace-delete'/);
  assert.doesNotMatch(INDEX.replace(del, ''), /deleteLegacyPalace\(/, 'never called anywhere else (never automatic)');
});

test('(b) legacyPalaceInfo: the palace, repair siblings, the mine-state file and interrupted-delete leftovers, with their size; null when there is none', () => {
  assert.equal(legacyPalaceInfo(home({ 'hive/x.md': 'x' })), null);
  assert.equal(legacyPalaceInfo(null), null);
  const h = home({ 'palace/chroma.sqlite3': 'abcd', 'palace/seg/data_level0.bin': '123456', 'palace.mempalace-rebuild-1/x': '12', 'palace.deleting-5/y': '1', '.mempalace-mine-state.json': '{}', 'hive/memory.md': 'not old data' });
  const info = legacyPalaceInfo(h);
  assert.deepEqual(info.paths.map((p) => path.basename(p)).sort(), ['.mempalace-mine-state.json', 'palace', 'palace.deleting-5', 'palace.mempalace-rebuild-1']);
  assert.equal(info.bytes, 4 + 6 + 2 + 1 + 2);
});

test('(b) deleteLegacyPalace: deletes all of it (real filesystem), leaves the hive alone', () => {
  const h = home({ 'palace/chroma.sqlite3': 'abcd', 'palace.mempalace-backup-2/z': 'z', '.mempalace-mine-state.json': '{}', 'hive/agents/a/memory.md': 'keep' });
  const r = deleteLegacyPalace(h);
  assert.equal(r.ok, true);
  assert.equal(r.paths.length, 3);
  assert.deepEqual(fs.readdirSync(h), ['hive']);
  assert.equal(fs.readFileSync(path.join(h, 'hive/agents/a/memory.md'), 'utf8'), 'keep');
  assert.deepEqual(deleteLegacyPalace(h), { ok: true, bytes: 0, paths: [] }, 'nothing left: a no-op');
});

test('(b) deleteLegacyPalace is ALL OR NOTHING: a locked file stops it, earlier moves are undone, the locked file is named, nothing is removed', () => {
  const h = home({ 'palace.mempalace-backup-1/a': 'a', 'palace/chroma.sqlite3': 'abcd', '.mempalace-mine-state.json': '{}' });
  const locked = path.join(h, '.mempalace-mine-state.json');   // the LAST path: two moves must be undone
  const removed = [];
  const fsx = {
    ...realFs,
    rename: (a, b) => { if (a === locked) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } realFs.rename(a, b); },
    rm: (p) => { removed.push(p); realFs.rm(p); },
    probeWrite: (p) => { if (p === locked) throw new Error('EBUSY'); }
  };
  const r = deleteLegacyPalace(h, fsx);
  assert.equal(r.ok, false);
  assert.match(r.error, /EBUSY.*nothing was deleted/);
  assert.deepEqual(r.locked, [locked]);
  assert.deepEqual(removed, []);
  assert.equal(fs.readFileSync(path.join(h, 'palace', 'chroma.sqlite3'), 'utf8'), 'abcd');
  assert.deepEqual(fs.readdirSync(h).sort(), ['.mempalace-mine-state.json', 'palace', 'palace.mempalace-backup-1'], 'everything back where it was');
});

// ── (d) the legacy MemoryManager is gone; D3 / D4 / M1 ───────────────────────────────────────

const { legacyDaemonRoots, stopLegacyDaemon } = loadTs('src/main/legacyPalace.ts');

test('(d) the legacy miner is deleted, and nothing in main starts mempalace, uv or python any more', () => {
  for (const f of ['memory.ts', 'incrementalMiner.ts', 'palaceReap.ts', 'palaceRebuild.ts']) {
    assert.equal(fs.existsSync(path.join(REPO, 'src', 'main', f)), false, f);
  }
  const dir = path.join(REPO, 'src', 'main');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(dir).filter((p) => /\.ts$/.test(p))) {
    const code = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.doesNotMatch(code, /spawn(Sync)?\(\s*(bin|['"](mempalace|uv|python)['"])/, path.relative(REPO, f));
    // devIsolation still SCRUBS an inherited MEMPALACE_PALACE_PATH (a 1.1.58 terminal's): never sets one.
    if (!f.endsWith('devIsolation.ts')) assert.doesNotMatch(code, /MEMPALACE_PALACE_PATH|MEMPALACE_EMBEDDING|MUNDER_LEGACY_MEMPALACE/, path.relative(REPO, f));
  }
  assert.doesNotMatch(read('src/shared/toolCatalog.ts'), /id: 'uv'|id: 'mempalace'/);
});

test('(d) D3: our legacy daemon is recognised by its real command line; an agent prompt quoting it, another palace, or a non-python process is not', () => {
  const palace = String.raw`C:\Dunder\palace`;
  const py = String.raw`C:\Users\X\AppData\Roaming\uv\tools\mempalace\Scripts\python.exe`;
  const rows = [
    { pid: 15668, parentPid: 22432, commandLine: String.raw`${py} -m mempalace.daemon serve --palace C:\Dunder\palace` },
    { pid: 22632, parentPid: 15668, commandLine: String.raw`${py} -m mempalace.daemon serve --palace C:\Dunder\palace` },
    { pid: 3, parentPid: 1, commandLine: String.raw`claude.exe --append-system-prompt "run python.exe -m mempalace.daemon serve --palace C:\Dunder\palace"` },
    { pid: 4, parentPid: 1, commandLine: String.raw`${py} -m mempalace.daemon serve --palace D:\Other\palace` },
    { pid: 5, parentPid: 1, commandLine: String.raw`"C:\Program Files\mempalace\mempalace.exe" --palace "c:/dunder/palace/" daemon serve` }
  ];
  assert.deepEqual(legacyDaemonRoots(rows, palace).map((r) => r.pid), [15668, 5], 'roots only (the child goes with its tree); quoted/forward-slash palace matches');
  assert.deepEqual(legacyDaemonRoots(rows, 'C:/Nowhere'), []);
});

test('(d) D3: stopped once, logged once; a survivor is reported as legacy-daemon-running; none / no listing = nothing', async () => {
  const cmd = String.raw`python.exe -m mempalace.daemon serve --palace C:\Dunder\palace`;
  const rows = [{ pid: 7, parentPid: 1, commandLine: cmd }];
  const logs = []; const kills = [];
  let alive = true;
  const deps = { probe: async () => (alive ? rows : []), kill: async (p) => { kills.push(p); alive = false; }, log: (r) => logs.push(r) };
  assert.equal(await stopLegacyDaemon(String.raw`C:\Dunder\palace`, deps), 'stopped');
  assert.deepEqual(kills, [[7]]);
  assert.deepEqual(logs.map((r) => [r.kind, r.pids]), [['legacy-daemon-stopped', [7]]]);
  const stuck = []; 
  assert.equal(await stopLegacyDaemon(String.raw`C:\Dunder\palace`, { probe: async () => rows, kill: async () => {}, log: (r) => stuck.push(r) }), 'running');
  assert.deepEqual(stuck.map((r) => [r.kind, r.pids]), [['legacy-daemon-running', [7]]]);
  const none = [];
  assert.equal(await stopLegacyDaemon(String.raw`C:\Dunder\palace`, { probe: async () => [], kill: async () => { throw new Error('no'); }, log: (r) => none.push(r) }), 'none');
  assert.equal(await stopLegacyDaemon(String.raw`C:\Dunder\palace`, { probe: async () => null, kill: async () => {}, log: (r) => none.push(r) }), 'none');
  assert.equal(await stopLegacyDaemon(null, deps), 'none');
  assert.deepEqual(none, []);
});

test('(d) D3 + D4 run at start-up, in the background: one memory-engine-json-ignored row when the file is there; the daemon stop is fire-and-forget', () => {
  const fn = between(INDEX, 'function noteLegacyMemoryOnStart(): void {', '\n}\n');
  assert.match(fn, /kind: 'memory-engine-json-ignored'/);
  assert.match(fn, /void stopLegacyDaemon\(home \? join\(home, 'palace'\) : null,/);
  assert.match(INDEX, /noteLegacyMemoryOnStart\(\);/);
});

test('(d) M1: the index delete covers the WAL/SHM and retries a handle Windows is still releasing', () => {
  const fn = between(INDEX, 'function deleteMemoryIndex(file: string | null): void {', '\n}\n');
  assert.match(fn, /\[file, `\$\{file\}-wal`, `\$\{file\}-shm`\]/);
  assert.match(fn, /maxRetries: 10/);
});
