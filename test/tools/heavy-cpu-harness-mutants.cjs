'use strict';
// HALFCORES-OVERSUBSCRIBE: the harness must reject a cmd-broken recovery child and a core-count-free M10 ratio.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const root = path.join(__dirname, '..', '..');
const source = path.join(root, 'test', 'heavy-cpu-harness-191.test.cjs');
const helper = path.join(root, 'resources', 'heavyjob', 'guppy-heavyjob.cs');
const create = "create ${id} 0 ${cap}${cap ? ` ${rate}` : ''}";
const mutants = [
  ['broken-child-path', 'process.execPath, childPath]', "process.execPath, join(dir, 'missing-child.cjs')]"],
  ['wrong-capacity-normaliser', source, 'open.cpu / open.wall / processors * 2500', '5000'],
  ['control-replaced-by-second-cap', source, 'const capped = await run(1, capRate, workerCount);', 'const capped = await run(0, capRate, workerCount);'],
  ['create-cap-off', source, create, 'create ${id} 0 0'],
  ['rate-dropped', source, create, 'create ${id} 0 ${cap}'],
  ['helper-ignores-rate', helper, 'CpuRate = cap ? cpuRate : 0', 'CpuRate = cap ? CPU_RATE_50_PERCENT : 0'],
];
mutants[0].splice(1, 0, source);
for (const [name, file, from, to] of mutants) {
  const original = fs.readFileSync(file, 'utf8');
  if (original.indexOf(from) < 0 || original.indexOf(from) !== original.lastIndexOf(from)) throw new Error(`${name}: anchor missing or ambiguous`);
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'hcpu-harness-mutant-'));
  const queryOriginal = name === 'helper-ignores-rate' ? fs.readFileSync(source, 'utf8') : null;
  try {
    // Keep the direct query oracle from killing this helper mutation first: M10 must reject it
    // from delivered CPU time versus the requested-rate ceiling.
    if (queryOriginal) fs.writeFileSync(source, queryOriginal.replace('rate: 2500, affinity: null', 'rate: 5000, affinity: null'));
    fs.writeFileSync(file, original.replace(from, to));
    const r = spawnSync(process.execPath, ['--test', 'test/heavy-cpu-harness-191.test.cjs'], { cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, LOCALAPPDATA: local } });
    if (r.status === 0) throw new Error(`SURVIVED ${name}: ${r.stdout}\n${r.stderr}`);
    console.log(`KILLED ${name}`);
  } finally { fs.writeFileSync(file, original); if (queryOriginal) fs.writeFileSync(source, queryOriginal); fs.rmSync(local, { recursive: true, force: true }); }
}
