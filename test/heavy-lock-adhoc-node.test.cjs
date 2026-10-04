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
