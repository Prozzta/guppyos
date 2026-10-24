'use strict';
require('./tools/own-job.cjs');
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
/** Source without // and block comments (a comment may name the retired code). The TypeScript scanner
 *  knows strings, templates and regexes, so a '/*' inside a string hides no code from the scans; a
 *  comment keeps its line breaks, so line numbers stay true. */
const ts = require('typescript');
function code(text) {
  const sc = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.JSX, text);
  const K = ts.SyntaxKind;
  // After these a '/' divides; anywhere else it starts a regex.
  const VALUE_END = new Set([K.Identifier, K.NumericLiteral, K.BigIntLiteral, K.StringLiteral, K.NoSubstitutionTemplateLiteral, K.TemplateTail,
    K.RegularExpressionLiteral, K.CloseParenToken, K.CloseBracketToken, K.CloseBraceToken, K.ThisKeyword, K.SuperKeyword, K.TrueKeyword,
    K.FalseKeyword, K.NullKeyword, K.PlusPlusToken, K.MinusMinusToken, K.ExclamationToken]);
  const braces = [];   // per open `${`: the `{` depth inside it
  let out = '';
  let prev = null;
  for (let k = sc.scan(); k !== K.EndOfFileToken; k = sc.scan()) {
    if (k === K.SingleLineCommentTrivia) continue;
    if (k === K.MultiLineCommentTrivia) { out += sc.getTokenText().replace(/[^\n]/g, ''); continue; }
    if ((k === K.SlashToken || k === K.SlashEqualsToken) && !VALUE_END.has(prev)) k = sc.reScanSlashToken();
    else if (k === K.CloseBraceToken && braces.length && braces[braces.length - 1] === 0) {
      k = sc.reScanTemplateToken(false);
      if (k === K.TemplateTail) braces.pop();
    } else if (k === K.OpenBraceToken && braces.length) braces[braces.length - 1]++;
    else if (k === K.CloseBraceToken && braces.length) braces[braces.length - 1]--;
    if (k === K.TemplateHead) braces.push(0);
    if (k !== K.WhitespaceTrivia && k !== K.NewLineTrivia) prev = k;
    out += sc.getTokenText();
  }
  return out;
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

test('ZT-I2 (3): no upkeep path in src/main or src/shared spawns claude in print mode', () => {
  const PRINT = /['"`](?:-p|--print)['"`]|\bclaude(?:\.cmd|\.exe)?["']?\s+(?:[^'"`\n]*\s)?(?:-p|--print)\b/;
  // Andy NIT-3: exact LINES, never whole files, so a new print-mode argv anywhere is a hit.
  const ALLOWED = [
    // The model list's initialize handshake: no prompt in its argv (pinned whole below), none on stdin.
    ['src/main/providerModels.ts', "export const CLAUDE_LIST_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];"],
    // heavyJob.ts reads a command's node -e/-p argv to classify it (its one spawn is pinned below).
    ['src/main/heavyJob.ts', "const e = args.findIndex((a) => a === '-e' || a === '--eval' || a === '-p' || a === '--print');"],
    // HEAVY-LOCK-OPAQUE-SCRIPT-196's processImage: `ps -p <pid>` names a process id, not claude's print mode.
    ['src/main/heavyJob.ts', ": ['ps', ['-o', 'comm=', '-p', String(pid)]];"],
    // Copilot's visible worker session takes its brief this way: an agent the Human sees, not upkeep.
    ['src/shared/agentProvider.ts', "initialPromptFlag: '-p',"]
  ];
  // Prose the app shows an agent (god's monitoring hint), not a command the app runs.
  const PROSE = ['Use `claude -p "..." --output-format json` for a one-off headless query.'];
  // The command reference shown to the Human and written to COMMANDS.md: one `cli` entry per line, text
  // only (the file imports nothing, pinned below, so nothing in it can run).
  const CATALOG = 'src/shared/claudeCommands.ts';
  const CATALOG_ITEM = /^\{ cmd: 'claude -p "[^"']*"[^']*', kind: 'cli', desc: '[^']*'(?:, usage: '[^']*')? \},?$/;
  const hits = [];
  const used = new Set();
  for (const { file, text } of SRC) {
    if (!file.startsWith('src/main/') && !file.startsWith('src/shared/')) continue;
    code(text).split('\n').forEach((line, i) => {
      if (!PRINT.test(line)) return;
      const ok = ALLOWED.findIndex(([f, l]) => f === file && line.trim() === l);
      if (ok >= 0 && !used.has(ok)) { used.add(ok); return; }
      if (PROSE.some((p) => line.includes(p))) return;
      if (file === CATALOG && CATALOG_ITEM.test(line.trim())) return;
      hits.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, [], 'a print-mode argv outside the allowed lines (each allowed once)');
  assert.equal(used.size, ALLOWED.length, 'every allowed line is still where it was');
  const catalog = code(fs.readFileSync(path.join(ROOT, ...CATALOG.split('/')), 'utf8'));
  assert.doesNotMatch(catalog, /^\s*import\b|\brequire\(|\bimport\(/m, 'the command reference imports nothing, so it runs nothing');
  const hj = code(fs.readFileSync(path.join(ROOT, 'src', 'main', 'heavyJob.ts'), 'utf8'));
  assert.doesNotMatch(hj, /(?<![.\w$])(?:spawn|spawnSync|execSync|execFileSync|fork|exec)\s*\(/, 'heavyJob runs no other child');
  assert.match(hj, /^import \{ execFile \} from 'node:child_process';$/m, 'and imports nothing else from child_process');
  assert.deepEqual(hj.match(/\bexecFile\(\s*'[^']*'/g), ["execFile('powershell.exe'"], 'its one child is the process listing');
  const pm = code(fs.readFileSync(path.join(ROOT, 'src', 'main', 'providerModels.ts'), 'utf8'));
  assert.deepEqual(pm.match(/\bargs = [^;\n]*/g), ['args = CLAUDE_LIST_ARGS', "args = ['/d', '/s', '/c', `\"\"${exe}\" ${CLAUDE_LIST_ARGS.join(' ')}\"`]"], 'claude is spawned with the handshake argv only (no prompt in argv)');
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
