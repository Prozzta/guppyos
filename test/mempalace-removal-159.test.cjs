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
