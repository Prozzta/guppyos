'use strict';
/**
 * ZT-I2-CONDENSE (god f2315f): the hidden Haiku condense is gone, and stays gone.
 *
 * (3) No upkeep path spawns `claude -p`: reflect.ts and hiddenClaude.ts are deleted, nothing imports
 *     them, and the only print-mode argv left in src/main is the model-list handshake, which sends one
 *     `initialize` control request and no prompt (so no model turn is spent).
 * (4) An old config.json that still has reflectEnabled (and the other reflect* tunables) loads with no
 *     error; the keys are dropped on read and removed from the file once, nothing else changes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'zti2-ud-'));
process.on('exit', () => { try { fs.rmSync(USERDATA, { recursive: true, force: true }); } catch { /* best effort */ } });
const ELECTRON = require.resolve('electron');
require.cache[ELECTRON] = { id: ELECTRON, filename: ELECTRON, loaded: true, exports: { app: { getPath: () => USERDATA } } };
const loadTs = require('./load-ts.cjs');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|cjs|js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
/** Source without // and block comments (a comment may name the retired code). */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}
const SRC = walk(path.join(ROOT, 'src')).map((p) => ({ file: rel(p), text: fs.readFileSync(p, 'utf8') }));

test('ZT-I2 (3): the hidden condense is deleted and nothing reaches for it', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'src', 'main', 'reflect.ts')), false, 'reflect.ts is gone');
  assert.equal(fs.existsSync(path.join(ROOT, 'src', 'main', 'hiddenClaude.ts')), false, 'hiddenClaude.ts is gone');
  for (const { file, text } of SRC) {
    const c = code(text);
    assert.doesNotMatch(c, /from ['"][./]+(?:[\w/]+\/)?(?:reflect|hiddenClaude)['"]|require\(['"][./]+(?:[\w/]+\/)?(?:reflect|hiddenClaude)['"]\)/, `${file} imports the retired condense`);
    assert.doesNotMatch(c, /memory:reflectNow|reflectNow\b|MemoryReflector|CONDENSE_MODEL/, `${file} still wires the retired condense`);
    assert.doesNotMatch(c, /\.reflect(?:Enabled|IntervalMs|ByteTriggerPct|SectionTrigger|RecentKeep|MinBytes)\b|^\s*reflect(?:Enabled|IntervalMs|ByteTriggerPct|SectionTrigger|RecentKeep|MinBytes)\??:/m, `${file} reads or declares a retired reflect* key`);
  }
});

test('ZT-I2 (3): no upkeep path in src/main spawns claude in print mode', () => {
  // The one print-mode argv allowed: the model list's initialize handshake (no prompt is sent).
  const ALLOWED = new Set(['src/main/providerModels.ts']);
  // heavyJob.ts reads a command's node -p/-e argv to classify it; it spawns nothing with them.
  const PARSES_ONLY = new Set(['src/main/heavyJob.ts']);
  // Prose the app shows an agent (god's monitoring hint), not a command the app runs.
  const PROSE = ['Use `claude -p "..." --output-format json` for a one-off headless query.'];
  const hits = [];
  for (const { file, text } of SRC) {
    if (!file.startsWith('src/main/') || PARSES_ONLY.has(file)) continue;
    code(text).split('\n').forEach((line, i) => {
      if (!/['"`](?:-p|--print)['"`]|\bclaude(?:\.cmd|\.exe)?["']?\s+(?:[^'"`\n]*\s)?(?:-p|--print)\b/.test(line)) return;
      if (ALLOWED.has(file) || PROSE.some((p) => line.includes(p))) return;
      hits.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, [], 'a print-mode claude argv outside the model-list handshake');
  const pm = code(fs.readFileSync(path.join(ROOT, 'src', 'main', 'providerModels.ts'), 'utf8'));
  const writes = pm.match(/stdin\?*\.write\(/g) || [];
  assert.equal(writes.length, 1, 'the handshake writes exactly one line to claude');
  assert.match(pm, /stdin\?\.write\(`\$\{JSON\.stringify\(\{ type: 'control_request', request_id: CLAUDE_REQUEST_ID, request: \{ subtype: 'initialize' \} \}\)\}\\n`\)/, 'and it is the initialize control request');
  assert.doesNotMatch(pm, /type: 'user'/, 'no prompt is ever sent to it');
});

test('ZT-I2 (3): no timer in main is left to run a memory condense', () => {
  const index = code(fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.ts'), 'utf8'));
  assert.doesNotMatch(index, /reflector/, 'index.ts has no reflector to start or stop');
  const preload = code(fs.readFileSync(path.join(ROOT, 'src', 'preload', 'index.ts'), 'utf8'));
  assert.doesNotMatch(preload, /reflectNow|memory:reflectNow/);
});

test('ZT-I2 (4): an old config.json that still has the reflect* keys loads without error and loses only them', () => {
  const { readConfig, pruneRetiredConfigKeys, RETIRED_CONFIG_KEYS } = loadTs('src/main/config.ts');
  const REFLECT = ['reflectEnabled', 'reflectIntervalMs', 'reflectByteTriggerPct', 'reflectSectionTrigger', 'reflectRecentKeep', 'reflectMinBytes'];
  assert.deepEqual([...RETIRED_CONFIG_KEYS], ['embeddingModel', ...REFLECT]);
  const file = path.join(USERDATA, 'config.json');
  const old = { reflectEnabled: false, reflectIntervalMs: 600000, reflectByteTriggerPct: 40, reflectSectionTrigger: 30, reflectRecentKeep: 8, reflectMinBytes: 8192, semanticMemory: true, custom: { a: 1 } };
  fs.writeFileSync(file, JSON.stringify(old));
  let cfg;
  assert.doesNotThrow(() => { cfg = readConfig(); }, 'an old config loads');
  for (const k of REFLECT) assert.equal(k in cfg, false, `${k} is dropped on read`);
  assert.equal(cfg.semanticMemory, true, 'the rest is read as before');
  assert.equal(fs.readdirSync(USERDATA).some((n) => /corrupt|quarantine/i.test(n)), false, 'not treated as a corrupt config');
  // A migration on that read may already have persisted the file without them; start again for the prune.
  fs.writeFileSync(file, JSON.stringify(old));
  assert.deepEqual(pruneRetiredConfigKeys().sort(), [...REFLECT].sort());
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { semanticMemory: true, custom: { a: 1 } }, 'only the retired keys went');
  assert.deepEqual(pruneRetiredConfigKeys(), [], 'idempotent');
  // Defaults carry none of them either (a write after a fresh read must not bring them back).
  fs.rmSync(file);
  const fresh = readConfig();
  for (const k of REFLECT) assert.equal(k in fresh, false, `${k} is not a default any more`);
});
