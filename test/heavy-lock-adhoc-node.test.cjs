'use strict';
/**
 * HEAVY-LOCK-ADHOC-NODE (god b6b24a). Ad-hoc `node <script>.cjs` runs that load the ONNX runtime
 * and the embedder ran beside a held heavy-job slot: classifyCommand made `node <script>` heavy only
 * for a bench-like NAME, a suite runner, or a wrapped suite, and never read a node script's text.
 * Now what the script (or its relative helpers, or `node -e` code) LOADS decides: onnxruntime,
 * transformers, the native-memory embedder/engine, a claims drill or bed run, the test runner, or
 * ELECTRON_RUN_AS_NODE. A module name that is only mentioned (a string, a comment) stays light.
 * All script texts and paths here are invented.
 *
 * Named mutants, each must fail this file:
 *   A1 a node script's text is never read
 *   A2 relative helpers are not followed
 *   A3 a mere mention (no load or spawn call) counts
 *   A4 `node -e` code is not inspected
 *   A5 ELECTRON_RUN_AS_NODE is ignored
 *   A6 an earlier `cd X` is not used to find the script
 *   A7 helpers are followed without the hop limit
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const HJ = loadTs('src/main/heavyJob.ts');
const { HookServer } = loadTs('src/main/hooks.ts');

const scripts = (files) => ({ readScript: (p, cd) => files[cd ? `${cd}|${p}` : p] ?? null });
const ORT = "const ort = require(path.join(TREE, 'node_modules/onnxruntime-node'));\n";

test('a node script that loads onnxruntime or the embedder is a bench, whatever its name', () => {
  const ctx = scripts({
    'scratch/costs.cjs': `const path = require('path');\n${ORT}console.log(1);\n`,
    'scratch/cosine.cjs': "const { OnnxEmbedder } = loadTs('src/main/nativeMemory/embedder.ts');\n",
    'scratch/esm.mjs': "import {\n  pipeline,\n} from '@huggingface/transformers';\n",
    'scratch/engine.cjs': "const E = loadTs('src/main/nativeMemory/engine.ts');\n",
    'scratch/drill.cjs': "const r = require('../claims-drill/runner.cjs');\n",
    'scratch/suite.cjs': "spawnSync(process.execPath, ['test/tools/run-tests.cjs'], { stdio: 'inherit' });\n",
  });
  const c = HJ.classifyCommand('node scratch/costs.cjs', 0, ctx);
  assert.equal(c.heavy, true, 'AN EMBEDDER SCRIPT IS SEEN');
  assert.equal(c.kind, 'bench');
  assert.match(c.why, /costs\.cjs \(loads onnxruntime-node\)/);
  for (const s of ['cosine.cjs', 'esm.mjs', 'engine.cjs', 'drill.cjs', 'suite.cjs']) {
    assert.equal(HJ.classifyCommand(`node scratch/${s} --out x.json`, 0, ctx).heavy, true, s);
  }
  assert.equal(HJ.classifyCommand('node scratch/costs.cjs').heavy, false, 'no reader: the pure default is unchanged');
  assert.equal(HJ.classifyHeavy('Bash', { command: 'node scratch/costs.cjs > out.json 2> err.txt' }, ctx).heavy, true);
  assert.equal(HJ.classifyCommand('bash -c "node scratch/costs.cjs"', 0, ctx).heavy, true, 'inside a shell wrapper too');
});

test('light scripts stay light: a mention in a string or comment, one test file spawned, an unreadable file', () => {
  const ctx = scripts({
    'mk-mail.cjs': "const fs = require('fs');\n// numbers from the onnxruntime-node run\nconst body = `onnxruntime-node and nativeMemory/embedder were slow; see claims-drill`;\nfs.writeFileSync('o.json', body);\n",
    'one.cjs': "spawnSync('node', ['--test', 'test/one.test.cjs']);\n",
    'counts.cjs': "const bed = require('C:/w/test/claims-bed/bed.cjs');\nconsole.log(bed.length);\n",
  });
  assert.equal(HJ.classifyCommand('node mk-mail.cjs', 0, ctx).heavy, false, 'A MENTION IS NOT A LOAD');
  assert.equal(HJ.classifyCommand('node one.cjs', 0, ctx).heavy, false, 'one test file stays light');
  assert.equal(HJ.classifyCommand('node counts.cjs', 0, ctx).heavy, false, 'reading the bed is not a bed run');
  assert.equal(HJ.classifyCommand('node missing.cjs', 0, ctx).heavy, false, 'unreadable: as for shell scripts');
  assert.equal(HJ.classifyCommand('node data.json', 0, scripts({ 'data.json': ORT })).heavy, false, 'not a script');
});

test('relative helpers are followed two hops (with or without an extension), and cycles end', () => {
  const ctx = scripts({
    'w/run.cjs': "const e = require('./lib/embed');\ne.go();\n",
    'w/lib/embed.cjs': "const x = require('../util.js');\nmodule.exports = { go() {} };\n",
    'w/util.js': ORT,
    'w/deep.cjs': "require('./h1.cjs');\n",
    'w/h1.cjs': "require('./h2.cjs');\n",
    'w/h2.cjs': "require('./h3.cjs');\n",
    'w/h3.cjs': ORT,
    'w/a.cjs': "require('./b.cjs');\n",
    'w/b.cjs': "require('./a.cjs');\n",
  });
  const c = HJ.classifyCommand('node w/run.cjs', 0, ctx);
  assert.equal(c.heavy, true, 'A HELPER THAT LOADS THE RUNTIME IS SEEN');
  assert.match(c.why, /run\.cjs via util\.js/);
  assert.equal(HJ.classifyCommand('node w/deep.cjs', 0, ctx).heavy, false, 'three hops deep: beyond the limit');
  assert.equal(HJ.classifyCommand('node w/a.cjs', 0, ctx).heavy, false, 'a require cycle ends');
});

test('`node -e` code, ELECTRON_RUN_AS_NODE, and an earlier `cd X`', () => {
  assert.equal(HJ.classifyCommand(`node -e "require('onnxruntime-node')"`).heavy, true, 'INLINE CODE IS SEEN');
  assert.equal(HJ.classifyCommand('node -e "console.log(require(\'fs\').existsSync(\'x\'))"').heavy, false);
  const ctx = scripts({
    'app.cjs': "const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };\nspawn(exe, ['x.cjs'], { env });\n",
    'C:/Dunder/_work/x|costs.cjs': ORT,
  });
  assert.equal(HJ.classifyCommand('node app.cjs', 0, ctx).why, 'node app.cjs (loads ELECTRON_RUN_AS_NODE)');
  assert.equal(HJ.classifyCommand('cd C:/Dunder/_work/x && node costs.cjs', 0, ctx).heavy, true, 'CD IS FOLLOWED');
  assert.equal(HJ.classifyCommand('node costs.cjs', 0, ctx).heavy, false);
});

test('through the hook\'s real script reader (files on disk, cwd-relative)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heavy-adhoc-'));
  try {
    fs.mkdirSync(path.join(dir, 'm4'));
    fs.writeFileSync(path.join(dir, 'm4', 'net.cjs'), "const h = require('./h.cjs');\n");
    fs.writeFileSync(path.join(dir, 'm4', 'h.cjs'), "const { OnnxEmbedder } = loadTs('src/main/nativeMemory/embedder.ts');\n");
    fs.writeFileSync(path.join(dir, 'm4', 'tally.cjs'), "console.log(require('./h-light.cjs'));\n");
    fs.writeFileSync(path.join(dir, 'm4', 'h-light.cjs'), 'module.exports = 3;\n');
    const ctx = HookServer.heavyScriptCtx(dir);
    assert.equal(HJ.classifyHeavy('Bash', { command: 'node m4/net.cjs' }, ctx).heavy, true);
    assert.equal(HJ.classifyHeavy('Bash', { command: 'node m4/tally.cjs' }, ctx).heavy, false);
    assert.equal(HJ.classifyHeavy('Bash', { command: `node ${path.join(dir, 'm4', 'net.cjs').replace(/\\/g, '/')}` }, HookServer.heavyScriptCtx(null)).heavy, true, 'an absolute path');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ——— Jim's audit of 8ca7e6f3 (F1-F5 false denies, M1-M8 misses, P1 cost, J8-J10 caps) ———

const JIM = [
  // [name, heavy?, command, files]
  ['F1 a mail body naming require(marker)', false, 'node mail.cjs', { 'mail.cjs': "const body = 'the bench does require(\'onnxruntime-node\') then exits';\n" }],
  ['F2 a light require with a marker in a trailing comment', false, 'node a.cjs', { 'a.cjs': "const fs = require('fs') // the onnxruntime-node notes\n" }],
  ['F2b a commented-out require', false, 'node c.cjs', { 'c.cjs': "// const ort = require('onnxruntime-node');\n/* require('onnxruntime-node') */\nconsole.log(1);\n" }],
  ['F3b RegExp .exec( on a string naming a marker', false, 'node scan2.cjs', { 'scan2.cjs': "const m = /a/.exec('see onnxruntime-node');\n" }],
  ['F3c child_process.exec of the suite', true, 'node cp.cjs', { 'cp.cjs': "child_process.exec('node test/tools/run-tests.cjs');\n" }],
  ['F3 RegExp .exec( then a marker on the line', false, 'node scan.cjs', { 'scan.cjs': "if (/x/.exec(s)) console.log('no onnxruntime-node here')\n" }],
  ['F4 reading the bed runner as text', false, 'node r.cjs', { 'r.cjs': "const t = require('fs').readFileSync('test/claims-bed/run.cjs', 'utf8');\n" }],
  ['F4b require.resolve of the bed runner', false, 'node rr.cjs', { 'rr.cjs': "console.log(require.resolve('C:/w/test/claims-bed/run.cjs'))\n" }],
  ['F5 ELECTRON_RUN_AS_NODE in a comment', false, 'node b.cjs', { 'b.cjs': '// never set ELECTRON_RUN_AS_NODE here\nconsole.log(1)\n' }],
  ['F5b ELECTRON_RUN_AS_NODE in a string, and compared', false, 'node m.cjs', { 'm.cjs': "const body = 'check ELECTRON_RUN_AS_NODE in the env';\nif (process.env.ELECTRON_RUN_AS_NODE === '1') console.log(body);\n" }],
  ['F5c ELECTRON_RUN_AS_NODE assigned', true, 'node m2.cjs', { 'm2.cjs': "process.env.ELECTRON_RUN_AS_NODE = '1';\n" }],
  ['F5d ELECTRON_RUN_AS_NODE as a quoted key', true, 'node m3.cjs', { 'm3.cjs': "spawn(exe, [], { env: { 'ELECTRON_RUN_AS_NODE': '1' } });\n" }],
  ['M1 a wrapped require(', true, 'node ml.cjs', { 'ml.cjs': "const ort = require(\n  'onnxruntime-node'\n);\n" }],
  ['M2 a helper via path.join(__dirname, …)', true, 'node j.cjs', { 'j.cjs': "const h = require(path.join(__dirname, 'h.cjs'));\n", 'h.cjs': "require('onnxruntime-node')\n" }],
  ['M2b a helper via an absolute path', true, 'node k.cjs', { 'k.cjs': "require('C:/x/h.cjs')\n", 'C:/x/h.cjs': "require('onnxruntime-node')\n" }],
  ['M3 an ESM side-effect import', true, 'node e.mjs', { 'e.mjs': "import 'onnxruntime-node';\n" }],
  ['M3b a side-effect import of a helper', true, 'node s.mjs', { 's.mjs': "import './h.mjs';\n", 'h.mjs': "import 'x'; const o = await import('onnxruntime-node');\n" }],
  ['M3c inline module code', true, `node --input-type=module -e "import 'onnxruntime-node'"`, null],
  ['M4 --eval=code', true, "node --eval=require('onnxruntime-node')", null],
  ['M5 node - (stdin the lock cannot see)', true, 'node -', {}],
  ['M5b a heredoc script', true, "node <<'EOF'\nconst ort = require('onnxruntime-node');\nEOF", {}],
  ['M5c a light heredoc script', false, "node <<'EOF'\nconsole.log(require('fs').existsSync('x'));\nEOF", {}],
  ['M5d a < file script', true, 'node < feed.cjs', { 'feed.cjs': "require('onnxruntime-node')\n" }],
  ['M6 createRequire', true, 'node cr.mjs', { 'cr.mjs': "const req = createRequire(import.meta.url);\nconst ort = req('onnxruntime-node');\n" }],
  ['M7 a spawn of a script named by a constant', true, 'node sp.cjs', { 'sp.cjs': "const s = 'test/tools/run-tests.cjs';\nspawnSync(process.execPath, [s]);\n" }],
  ['M8 npx tsx', true, 'npx tsx bench-like.ts', { 'bench-like.ts': "import ort from 'onnxruntime-node';\n" }],
  ['a --require preload', true, 'node --require ./pre.cjs light.cjs', { './pre.cjs': "require('onnxruntime-node')\n", 'light.cjs': 'console.log(1)\n' }],
  ['node --version stays light', false, 'node --version', {}],
];
for (const [name, want, cmd, files] of JIM) {
  test(`audit probe: ${name} -> ${want ? 'heavy' : 'light'}`, () => {
    assert.equal(HJ.classifyCommand(cmd, 0, files ? scripts(files) : {}).heavy, want);
  });
}

test('P1: tokenising a hostile 256 KB line stays fast (linear, bounded argument reads)', () => {
  for (const unit of ['require(', 'exec(x ', "from 'a' ", '`${', '/*']) {
    const t = unit.repeat(Math.floor(256 * 1024 / unit.length));
    const s = process.hrtime.bigint();
    HJ.classifyCommand('node big.cjs', 0, scripts({ 'big.cjs': t }));
    const ms = Number(process.hrtime.bigint() - s) / 1e6;
    assert.ok(ms < 1500, `256 KB of "${unit}" took ${ms.toFixed(0)} ms`);
  }
  assert.equal(HJ.HEAVY_JS_SCAN_CHARS, 256 * 1024);
});

test('J8-J10: at most 8 files read, a throwing reader is light, a cycle is read once', () => {
  const reads = [];
  const fan = { readScript: (p) => { reads.push(p); return p === 'f.cjs' ? Array.from({ length: 40 }, (_, i) => `require('./h${i}.cjs')`).join('\n') : (p === 'h39.cjs' ? "require('onnxruntime-node')" : 'module.exports = 1'); } };
  assert.equal(HJ.classifyCommand('node f.cjs', 0, fan).heavy, false, 'the 40th helper is beyond the cap');
  assert.equal(reads.length, HJ.HEAVY_JS_MAX_FILES, 'J8: STOPS AT 8 READS');
  let thrown = 0;
  assert.equal(HJ.classifyCommand('node z.cjs', 0, { readScript: () => { thrown++; throw new Error('EACCES'); } }).heavy, false, 'J9: A THROW IS LIGHT');
  assert.ok(thrown >= 1);
  const cyc = [];
  const loop = { readScript: (p) => { cyc.push(p); return p === 'a.cjs' ? "require('./b.cjs')" : p === 'b.cjs' ? "require('./a.cjs')" : null; } };
  assert.equal(HJ.classifyCommand('node a.cjs', 0, loop).heavy, false);
  assert.deepEqual(cyc, ['a.cjs', 'b.cjs'], 'J10: EACH FILE OF A CYCLE IS READ ONCE');
});

test('scriptReaderFor: a read that throws after the stat gives null (no throw into the hook)', () => {
  const ctx = HJ.scriptReaderFor('C:/w', () => ({ size: 10, text: () => { throw new Error('EBUSY'); } }));
  assert.equal(ctx.readScript('x.cjs'), null);
});
