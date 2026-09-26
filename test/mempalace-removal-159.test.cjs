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
  assert.ok(spawn.indexOf('semanticMemory: mem !== null') < spawn.indexOf('opts.env = { ...base, ...mem.env'), 'the prompt gate and the env come from the same decision');
  assert.match(spawn, /\[pathKey\]: basePath \? `\$\{mem\.shimDir\}\$\{delimiter\}\$\{basePath\}` : mem\.shimDir/, 'the shim dir goes FIRST on the final PATH');
  assert.doesNotMatch(INDEX, /semanticMemory: memory\.active\(\)/, 'no longer gated on a legacy binary');
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
