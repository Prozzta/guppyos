'use strict';
// HALFCORES-OVERSUBSCRIBE: each narrow regression mutant must be rejected by the focused view suite.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.join(__dirname, '..', '..');
const { recover, mutateFile, restoreFile, checkAnchors } = require('./mutant-runner-helper.cjs');
recover(root);
if (process.argv.includes('--recover-only')) process.exit(0);
const source = path.join(root, 'test', 'electron-harness', 'electron-bin.cjs');
const original = fs.readFileSync(source, 'utf8');
const mutants = [
  ['delete-capped-view', 'return limit === null ? half : (limit & half) || limit;', 'return null;'],
  ['ignore-view-ini', 'return sm === null || fs.readFileSync(join(dir, \'SwiftShader.ini\'), \'utf8\') === `[Processor]\\nAffinityMask=${sm}\\n`;', 'return true;'],
  ['keep-broken-view', 'entry.startsWith(`${basename(dir)}.broken-`)', 'false'],
  ['drop-self-query-timeout', "timeout: 15_000, env }));", "timeout: 0, env }));"],
  ['drop-affinity-probe-timeout', "timeout: 15_000, env: require('../tools/ps-env.cjs').psEnv(env) });", "timeout: 0, env: require('../tools/ps-env.cjs').psEnv(env) });"],
  ['no-mask-cache', 'if (!cachedHarnessMasks.has(key))', 'if (true)'],
  ['wrong-mask-cache-key', 'const key = String(override);', "const key = 'all-overrides';"],
];
checkAnchors(root, mutants.map(([name, from]) => ({ name, file: source, from })));
for (const [name, from, to] of mutants) {
  if (original.indexOf(from) < 0 || original.indexOf(from) !== original.lastIndexOf(from)) throw new Error(`${name}: anchor missing or ambiguous`);
  try {
    mutateFile(root, source, original, original.replace(from, to));
    const r = spawnSync(process.execPath, ['--test', 'test/electron-view-self-heal-198.test.cjs'], { cwd: root, encoding: 'utf8', windowsHide: true });
    if (r.status === 0) throw new Error(`SURVIVED ${name}: ${r.stdout}\n${r.stderr}`);
    console.log(`KILLED ${name}`);
  } finally { restoreFile(root, source, original); }
}
