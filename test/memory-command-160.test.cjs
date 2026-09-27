'use strict';

/**
 * WIPE (1.1.60; the Human 2026-09-27: "wipe" the retired memory CLI). Agents' memory command is
 * `memory` (search, wake-up, status), served by the built-in memory engine. 1.1.59 left agents
 * resolving the old CLI because the command dir was lost from PATH: buildPtyEnv added a second
 * `PATH` key beside Windows' `Path` (Jim POST-INSTALL-159 item 7). This file pins:
 *   - ONE PATH key in every agent env, with the memory command's dir first;
 *   - the prompt, protocol and skill text naming `memory`;
 *   - the one-time cleanup of files and config keys older builds generated;
 *   - (the tracked-tree guard is test/no-retired-memory-cli.test.cjs).
 * Every temp dir it makes is under one jail, removed after the run.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const REPO = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');
const INDEX = read('src/main/index.ts');
const HIVE = read('src/main/hive.ts');
const between = (src, a, b) => { const i = src.indexOf(a); assert.ok(i >= 0, a); const j = src.indexOf(b, i + a.length); assert.ok(j > i, b); return src.slice(i, j); };

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'memcmd160-'));
test.after(() => fs.rmSync(JAIL, { recursive: true, force: true }));
const dir = (p) => fs.mkdtempSync(path.join(JAIL, p));

// config.ts reads <userData>/config.json through electron's app; hive.ts loads it too, and load-ts
// caches modules, so the stub goes in BEFORE anything is loaded.
const USERDATA = dir('ud-');
const ELECTRON = require.resolve('electron');
require.cache[ELECTRON] = { id: ELECTRON, filename: ELECTRON, loaded: true, exports: { app: { getPath: () => USERDATA } } };
const { buildPtyEnv } = loadTs('src/main/ptyEnv.ts');
const { HiveManager, RETIRED_AGENT_GITIGNORE } = loadTs('src/main/hive.ts');

/** The retired name, built so this file does not itself contain it. */
const OLD = new RegExp(['mem', 'palace'].join('\\s*'), 'i');

// ── ONE PATH, memory first ───────────────────────────────────────────────────

const pathKeys = (env) => Object.keys(env).filter((k) => k.toUpperCase() === 'PATH');

test('buildPtyEnv: a Windows parent `Path` + an agent `Path` + the app PATH give ONE key, with the memory dir first (the 1.1.59 bug)', () => {
  const env = buildPtyEnv({ Path: 'A;B', PATH: 'X', FOO: '1' }, 'U1;U2', { Path: 'S;Z', BAR: '2' }, 'win32', ['M']);
  assert.deepEqual(pathKeys(env), ['PATH'], 'exactly one PATH-like key');
  assert.equal(env.PATH, 'M;S;Z', 'the memory dir, then the agent\'s own PATH');
  assert.equal(env.FOO, '1');
  assert.equal(env.BAR, '2');
});

test('buildPtyEnv: without an agent PATH the base is userPath; the memory dir is not duplicated; no prepend = userPath as it was', () => {
  assert.equal(buildPtyEnv({ Path: 'A' }, 'U1;U2', { X: '1' }, 'win32', ['M']).PATH, 'M;U1;U2');
  assert.equal(buildPtyEnv({}, 'M;U', {}, 'win32', ['M']).PATH, 'M;U', 'already on it: moved first, not added twice');
  const plain = buildPtyEnv({ Path: 'A' }, 'U1;U2', undefined, 'win32');
  assert.deepEqual(pathKeys(plain), ['PATH']);
  assert.equal(plain.PATH, 'U1;U2');
  assert.equal(buildPtyEnv({ PATH: '/a' }, '/u:/v', {}, 'linux', ['/m']).PATH, '/m:/u:/v', 'POSIX separator');
});

test('spawn: the memory env and the dir come from ONE decision; pty.ts hands the dir to buildPtyEnv; the renderer cannot set it', () => {
  const spawn = between(INDEX, 'const mem = nativeMemory.spawnEnv(opts.hive.id);', 'catch (e) {');
  assert.match(spawn, /semanticMemory: mem !== null,/);
  assert.match(spawn, /if \(mem\) \{\n\s+opts\.env = \{ \.\.\.opts\.env, \.\.\.mem\.env \};\n\s+opts\.pathPrepend = \[mem\.commandDir\];/);
  const clear = INDEX.indexOf('opts.pathPrepend = undefined;');
  assert.ok(clear > 0 && clear < INDEX.indexOf('const mem = nativeMemory.spawnEnv(opts.hive.id);'), 'cleared before the hive block');
  assert.match(read('src/main/pty.ts'), /env: buildPtyEnv\(process\.env, userPath, opts\.env, process\.platform, opts\.pathPrepend\)/);
});

// ── the text agents read ─────────────────────────────────────────────────────

test('agent-facing text names the `memory` command (prompt line, PROTOCOL.md, the capabilities skill, the orientation prompt)', () => {
  const line = between(HIVE, 'const memoryLine = semanticMemory', ": '';");
  assert.match(line, /run `memory search "<query>"`; run `memory wake-up`/);
  const proto = between(HIVE, '## Semantic memory', '// ─── cth-hook shim');
  assert.match(proto, /the \\`memory\\` command/);
  assert.match(proto, /\\`memory search "<query>"\\`/);
  assert.match(proto, /\\`memory wake-up\\`/);
  assert.match(read('resources/skills/capabilities/SKILL.md'), /`memory search "<query>"`/);
  assert.match(read('src/renderer/src/hooks/useHive.ts'), /run `memory wake-up`/);
  for (const [f, src] of [['hive.ts', HIVE], ['SKILL.md', read('resources/skills/capabilities/SKILL.md')], ['useHive.ts', read('src/renderer/src/hooks/useHive.ts')]]) {
    assert.doesNotMatch(src, OLD, f);
  }
});

test('the command ships as resources/memory-cli.cjs (packaged beside the models); the old script and its wrappers are gone', () => {
  assert.ok(fs.existsSync(path.join(REPO, 'resources', 'memory-cli.cjs')));
  assert.match(read('electron-builder.yml'), /- from: resources\/memory-cli\.cjs\n\s+to: memory-cli\.cjs/);
  assert.match(read('src/main/nativeMemory/mainWiring.ts'), /join\(this\.d\.resourcesDir, 'memory-cli\.cjs'\)/);
  assert.equal(fs.readdirSync(path.join(REPO, 'resources')).some((f) => OLD.test(f)), false);
});

// ── the old engine's pieces are gone ─────────────────────────────────────────

test('IPC: search / wake-up / status go to the memory engine; there is no old-data delete, no start-up legacy note, no legacy module', () => {
  const ipc = between(INDEX, '// ─── IPC: semantic memory (the memory engine)', '// Condense memory.md on demand');
  assert.match(ipc, /nativeMemory\.query\('status'\)/);
  assert.match(ipc, /nativeMemory\.query\('search', \{ query,/);
  assert.match(ipc, /nativeMemory\.query\('wake-up'/);
  for (const gone of ['memory:deleteLegacyData', 'legacyPalace', 'stopLegacyDaemon', 'noteLegacyMemoryOnStart', 'memory-engine-json-ignored', "'hive:mineNow'"]) {
    assert.equal(INDEX.includes(gone), false, gone);
  }
  assert.equal(fs.existsSync(path.join(REPO, 'src', 'main', 'legacyPalace.ts')), false);
  assert.doesNotMatch(read('src/preload/index.ts'), /deleteLegacyMemoryData|mineNow|legacy: \{/);
  assert.doesNotMatch(read('src/renderer/src/components/MemoryPanel.tsx'), /deleteLegacy|legacy/i);
});

test('nothing in main starts the old CLI, uv or python, or sets an env var of the old engine', () => {
  for (const f of ['memory.ts', 'incrementalMiner.ts', 'palaceReap.ts', 'palaceRebuild.ts', 'legacyPalace.ts']) {
    assert.equal(fs.existsSync(path.join(REPO, 'src', 'main', f)), false, f);
  }
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(path.join(REPO, 'src')).filter((p) => /\.tsx?$/.test(p))) {
    const code = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(code, /spawn(Sync)?\(\s*['"](uv|python)['"]/, path.relative(REPO, f));
    assert.doesNotMatch(code, OLD, path.relative(REPO, f));
  }
});

test('M1 (kept): the index delete covers the WAL/SHM and retries a handle Windows is still releasing', () => {
  const fn = between(INDEX, 'function deleteMemoryIndex(file: string | null): void {', '\n}\n');
  assert.match(fn, /\[file, `\$\{file\}-wal`, `\$\{file\}-shm`\]/);
  assert.match(fn, /maxRetries: 10/);
});

// ── one-time cleanup of what older builds generated ─────────────────────────

test('pruneRetiredHiveFiles: removes the old mode file and each agent .gitignore that is EXACTLY the generated list (LF or CRLF); an edited one stays; runs from ensureHive', () => {
  const home = dir('hive-');
  const root = path.join(home, 'hive');
  const put = (rel, body) => { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return p; };
  const mode = put('memory-engine.json', '{"mode":"native"}');
  const lf = put('agents/a1/.gitignore', RETIRED_AGENT_GITIGNORE);
  const crlf = put('agents/a2/.gitignore', RETIRED_AGENT_GITIGNORE.replace(/\n/g, '\r\n'));
  const mine = put('agents/a3/.gitignore', RETIRED_AGENT_GITIGNORE + 'my-own-line\n');
  put('agents/a4/memory.md', 'm');
  const h = new HiveManager(() => home);
  try {
    h.ensureHive();
    assert.equal(fs.existsSync(mode), false, 'mode file removed');
    assert.equal(fs.existsSync(lf), false);
    assert.equal(fs.existsSync(crlf), false);
    assert.equal(fs.readFileSync(mine, 'utf8'), RETIRED_AGENT_GITIGNORE + 'my-own-line\n', 'an edited one is the user\'s');
    assert.equal(fs.readFileSync(path.join(root, 'agents', 'a4', 'memory.md'), 'utf8'), 'm');
    h.pruneRetiredHiveFiles(root);   // idempotent
  } finally { h.dispose(); }
  assert.equal(RETIRED_AGENT_GITIGNORE, 'settings.json\ncursor.json\ninbox/\noutbox/\n.codex/\n', 'the exact list 1.1.58 wrote');
  assert.match(between(HIVE, 'ensureHive(): void {', '\n  }\n'), /this\.pruneRetiredHiveFiles\(root\);/);
});

test('config: the retired model-choice key is removed from config.json once at start (nothing else in the file changes) and dropped on read', () => {
  {
    const { readConfig, pruneRetiredConfigKeys, RETIRED_CONFIG_KEYS } = loadTs('src/main/config.ts');
    assert.deepEqual([...RETIRED_CONFIG_KEYS], ['embeddingModel']);
    const file = path.join(USERDATA, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ embeddingModel: 'minilm', semanticMemory: true, custom: { a: 1 } }));
    assert.deepEqual(pruneRetiredConfigKeys(), ['embeddingModel']);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { semanticMemory: true, custom: { a: 1 } }, 'only the retired key went');
    assert.deepEqual(pruneRetiredConfigKeys(), [], 'idempotent');
    // readConfig drops it too (a migration may persist what it read, so it must never carry it back).
    fs.writeFileSync(file, JSON.stringify({ embeddingModel: 'minilm' }));
    assert.equal('embeddingModel' in readConfig(), false, 'dropped on read');
  }
  assert.match(INDEX, /const retiredKeys = pruneRetiredConfigKeys\(\);/);
});
