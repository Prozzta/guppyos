'use strict';
/**
 * CLAIM-LEDGER C4: the drill child, run by runner.cjs as `<tree's electron> child.cjs <spec.json>`
 * with ELECTRON_RUN_AS_NODE=1, cwd = the tree. It asserts the jail BEFORE it loads the drill script,
 * hands the script a `drill` object built from the TREE's own modules, and writes the result to
 * spec.out (Electron's stdout is not reliable on Windows).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const write = (r) => fs.writeFileSync(spec.out, JSON.stringify(r, null, 2));
const LEAK_RE = /^(HIVE_|AGENT_|MEMORY_|MUNDER_|CLAUDE_CODE_|CLAUDE|CTH_|KG_)/i;
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function jailProblem() {
  if (!same(os.homedir(), spec.home)) return `home-not-jailed (${os.homedir()})`;
  if (!process.env.USERPROFILE || !same(process.env.USERPROFILE, spec.home)) return 'home-not-jailed (USERPROFILE)';
  if (!process.env.APPDATA || !path.resolve(process.env.APPDATA).toLowerCase().startsWith(path.resolve(spec.home).toLowerCase())) return 'home-not-jailed (APPDATA)';
  const leaked = Object.keys(process.env).filter((k) => LEAK_RE.test(k));
  if (leaked.length) return `env-leak (${leaked.join(',')})`;
  if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE !== '1') return 'not-electron-as-node';
  return null;
}

(async () => {
  const checks = { harnessStarted: false, homeJailed: false, modelLoaded: false };
  try {
    const jail = jailProblem();
    if (jail) { write({ ok: false, reason: jail, checks }); return; }
    process.chdir(spec.tree);
    const loadTsMod = require(path.join(spec.tree, 'test', 'load-ts.cjs'));
    const treeRequire = createRequire(path.join(spec.tree, 'package.json'));
    const manifest = JSON.parse(fs.readFileSync(path.join(spec.tree, 'resources', 'models', 'native-memory-manifest.json'), 'utf8'));
    const modelDir = path.join(spec.tree, 'resources', 'models', manifest.model.dir);
    const vecPath = treeRequire('sqlite-vec').getLoadablePath();
    const plat = `${process.platform}-${process.arch}`;
    const vecSha256 = manifest.vec0?.[plat]?.sha256 ?? null;
    const actualVec = crypto.createHash('sha256').update(fs.readFileSync(vecPath)).digest('hex');
    if (!vecSha256 || actualVec !== vecSha256) { write({ ok: false, reason: `vec digest mismatch (${actualVec})`, checks }); return; }
    const Database = treeRequire('better-sqlite3');
    const loadTs = (rel) => loadTsMod(path.resolve(spec.tree, rel));
    const drill = {
      tree: spec.tree, hive: spec.hive, home: spec.home, args: spec.args,
      loadTs, require: treeRequire,
      modelDir, modelSha256: manifest.model.onnxSha256, vecPath, vecSha256,
      openOpts: { Database, vecPath, vecSha256 },
      /** The TREE's own embedder over its own model. */
      makeEmbedder(options = { intraOpNumThreads: 2 }) {
        const { WordPieceTokenizer, wordPieceConfigFromTokenizerJson } = loadTs('src/main/nativeMemory/wordpiece.ts');
        const { OnnxEmbedder } = loadTs('src/main/nativeMemory/embedder.ts');
        const tok = new WordPieceTokenizer(wordPieceConfigFromTokenizerJson(JSON.parse(fs.readFileSync(path.join(modelDir, 'tokenizer.json'), 'utf8'))));
        return new OnnxEmbedder(path.join(modelDir, 'onnx', 'model.onnx'), tok, treeRequire('onnxruntime-node'), options);
      },
      assert: {
        harnessStarted() { checks.harnessStarted = true; },
        homeJailed() {
          const j = jailProblem();
          if (j) throw new Error(j);
          checks.homeJailed = true;
        },
        async modelLoaded(embedder) {
          const [v] = await embedder.embed(['drill model check']);
          if (!embedder.loaded || !v || v.length !== 384) throw new Error('the model is not loaded');
          let n = 0; for (const x of v) n += x * x;
          if (Math.abs(Math.sqrt(n) - 1) > 1e-3) throw new Error('the model output is not a unit vector');
          checks.modelLoaded = true;
        },
      },
    };
    const fn = require(spec.script);
    const res = (await (typeof fn === 'function' ? fn : fn.default)(drill)) ?? {};
    const missing = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
    const ok = res.ok !== false && missing.length === 0;
    write({ ...res, ok, checks, ...(ok ? {} : { reason: res.reason ?? `F7 checks not asserted: ${missing.join(', ')}` }) });
  } catch (e) {
    write({ ok: false, reason: 'the drill threw', error: String((e && e.stack) || e).slice(0, 2000), checks });
  }
})().finally(() => setTimeout(() => process.exit(0), 50));
