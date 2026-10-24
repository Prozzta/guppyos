'use strict';
// HALFCORES-OVERSUBSCRIBE: the harness must reject a cmd-broken recovery child and a core-count-free M10 ratio.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const root = path.join(__dirname, '..', '..');
const source = path.join(root, 'test', 'heavy-cpu-harness-191.test.cjs');
const original = fs.readFileSync(source, 'utf8');
const mutants = [
  ['broken-child-path', 'process.execPath, childPath]', "process.execPath, join(dir, 'missing-child.cjs')]"],
  ['wrong-capacity-normaliser', 'open.cpu / open.wall / processors * 5000', '5000'],
  ['control-replaced-by-second-cap', 'const capped = await run(1, capRate);', 'const capped = await run(0);'],
];
for (const [name, from, to] of mutants) {
  if (original.indexOf(from) < 0 || original.indexOf(from) !== original.lastIndexOf(from)) throw new Error(`${name}: anchor missing or ambiguous`);
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'hcpu-harness-mutant-'));
  try {
    fs.writeFileSync(source, original.replace(from, to));
    const r = spawnSync(process.execPath, ['--test', 'test/heavy-cpu-harness-191.test.cjs'], { cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, LOCALAPPDATA: local } });
    if (r.status === 0) throw new Error(`SURVIVED ${name}: ${r.stdout}\n${r.stderr}`);
    console.log(`KILLED ${name}`);
  } finally { fs.writeFileSync(source, original); fs.rmSync(local, { recursive: true, force: true }); }
}
