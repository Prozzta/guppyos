// @heavy-lock live: compiles and invokes the shipped Windows Job Object helper.
/** HALFCORES-OVERSUBSCRIBE: live native proof of CPU-rate hard-cap mode and live application. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { availableParallelism, tmpdir } = require('node:os');
const { join, relative } = require('node:path');

const root = join(__dirname, '..');
const CSC = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const jailedEnv = (dir) => ({ ...process.env, LOCALAPPDATA: join(dir, 'localappdata') });

test('SAFE CLEANUP: a plain node --test run leaves a LocalAppData sentinel intact', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'hcpu-sentinel-'));
  const sentinel = join(sandbox, 'Munder Difflin', 'Guppy', 'keep-me.txt');
  try {
    require('node:fs').mkdirSync(join(sandbox, 'Munder Difflin', 'Guppy'), { recursive: true });
    writeFileSync(sentinel, 'keep');
    const r = spawnSync(process.execPath, ['--test', '--test-name-pattern', '^never-match$', __filename], { encoding: 'utf8', windowsHide: true, env: { ...process.env, LOCALAPPDATA: sandbox } });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.equal(existsSync(sentinel), true, 'a direct test run must not sweep LocalAppData');
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});

function serveChannel(stdout, write) {
  let buf = '';
  const queue = [];
  stdout.setEncoding('utf8');
  stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let r = null;
      try { r = JSON.parse(line); } catch { r = null; }
      if (r && typeof r.event === 'string') continue;
      queue.shift()?.(line);
    }
  });
  return (line) => new Promise((resolve) => { queue.push(resolve); write(`${line}\n`); });
}

test('the serve channel skips event lines and answers each request with its own reply (1.1.99 FINAL flake)', async () => {
  const { PassThrough } = require('node:stream');
  const out = new PassThrough();
  const sent = [];
  const replies = [
    ['{"event":"exit","job":"j","msg":7,"pid":1}\r\n{"event":"exit","job":"j","msg":7,"pid":2}\r\n', '{"ok":true}\r\n'],
    ['{"event":"exit","job":"j","msg":4,"pid":3}\r\n{"ok":true,"half":', 'true}\r\n'],
  ];
  const ask = serveChannel(out, (line) => {
    sent.push(line);
    const chunks = replies.shift();
    setImmediate(function next() { const c = chunks.shift(); if (c === undefined) return; out.write(c); setImmediate(next); });
  });
  assert.equal(await ask('set j 0 1'), '{"ok":true}');
  assert.equal(await ask('query j'), '{"ok":true,"half":true}');
  assert.deepEqual(sent, ['set j 0 1\n', 'query j\n']);
});

test('CENSUS: Electron scenarios take the shared harness executable, never require Electron as a spawn target', () => {
  const bad = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(file); continue; }
      if (!/\.(c|m)?js$/.test(entry.name) || file === join(__dirname, 'electron-harness', 'electron-bin.cjs')) continue;
      const source = readFileSync(file, 'utf8').replace(/const\s*\{[^}]*\}\s*=\s*require\(\s*['\"]electron['\"]\s*\)/g, '');
      if (/(?:=|spawn\w*\(|execFile\w*\()\s*require\(\s*['\"]electron['\"]\s*\)(?!\s*\.)/.test(source)) bad.push(relative(root, file));
    }
  };
  walk(__dirname);
  assert.deepEqual(bad, [], 'use electron-harness/electron-bin.cjs instead of spawning require(\'electron\') directly');
});

test('REGRESSIONS: cmd receives a child script path, and M10 normalises CPU cores by worker capacity', () => {
  const source = readFileSync(__filename, 'utf8');
  assert.match(source, /writeFileSync\(childPath, RECOVERY_CHILD\)/, 'the multi-line recovery program is materialised as a script');
  assert.match(source, /process\.execPath, childPath\]/, 'cmd join receives the script path, not a multi-line -e argument');
  assert.match(source, /const processors = availableParallelism\(\)/, 'M10 saturates the processors available to this process');
      assert.match(source, /const capRate = Math\.max\(100, Math\.floor\(open\.cpu \/ open\.wall \/ processors \* 2500\)\)/, 'M10 caps near a quarter of the measured open ceiling');
      assert.match(source, /Math\.round\(ceiling\.cpu \/ ceiling\.wall\)/, 'M10 sizes workers to the measured open ceiling');
      assert.match(source, /cappedCpuRate <= openCpuRate \* 0\.6/, 'M10 proves the cap reduces CPU time per wall second');
      assert.match(source, /cappedCpuRate <= targetCpuRate \* 1\.25/, 'M10 proves CPU time never exceeds the requested rate ceiling');
});

test('LIVE: a fresh cap-off job creates and joins, then cap on/off/on applies to the held job (M1/M8/M9)',
  { skip: process.platform !== 'win32' ? 'heavy jobs are Windows-only' : !existsSync(CSC) ? `no in-box csc at ${CSC}` : false, timeout: 120_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcpu-rate-'));
    let serve;
    try {
      const exe = join(dir, 'guppy-heavyjob.exe');
      const compiled = spawnSync(CSC, ['-nologo', '-O', `-out:${exe}`, join(root, 'resources', 'heavyjob', 'guppy-heavyjob.cs')], { encoding: 'utf8', windowsHide: true });
      assert.equal(compiled.status, 0, `csc: ${compiled.stdout}${compiled.stderr}`);
      serve = spawn(exe, ['serve'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env: jailedEnv(dir) });
      const ask = serveChannel(serve.stdout, (line) => serve.stdin.write(line));
      const request = async (line) => JSON.parse(await ask(line));
      const id = `rate-${process.pid}-${Date.now().toString(36)}`;
      const offId = `${id}-off`;
      assert.deepEqual(await request(`create ${offId} 0 0`), { ok: true }, 'fresh cap-off must not call class 15 with flags zero');
      assert.deepEqual(await request(`query ${offId}`), { ok: true, background: false, cap: false, rate: 0, affinity: null });
      const joinedOff = spawnSync(exe, ['join', offId, '0', '0'], { encoding: 'utf8', windowsHide: true, env: jailedEnv(dir) });
      assert.equal(joinedOff.status, 0, `fresh cap-off join: ${joinedOff.stdout}${joinedOff.stderr}`);
      assert.deepEqual(await request(`close ${offId}`), { ok: true });
      assert.deepEqual(await request(`create ${id} 0 1`), { ok: true });
      assert.deepEqual(await request(`query ${id}`), { ok: true, background: false, cap: true, rate: 5000, affinity: null });
      assert.deepEqual(await request(`set ${id} 0 0`), { ok: true });
      assert.deepEqual(await request(`query ${id}`), { ok: true, background: false, cap: false, rate: 0, affinity: null });
      assert.deepEqual(await request(`set ${id} 1 1`), { ok: true });
      assert.deepEqual(await request(`query ${id}`), { ok: true, background: true, cap: true, rate: 5000, affinity: null });
      assert.deepEqual(await request(`close ${id}`), { ok: true });
    } finally {
      try { serve?.stdin.end(); } catch { /* gone */ }
      if (serve?.exitCode === null) await new Promise((resolve) => serve.once('exit', resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  });

const RECOVERY_CHILD = `
const { runScenario } = require(${JSON.stringify(join(root, 'test', 'electron-harness', 'run.cjs'))});
const scenario = ${JSON.stringify(join(root, 'test', 'electron-harness', 'scenarios', 'app-recovery.tsx'))};
process.stdout.write('HCPU-READY\\n');
runScenario(scenario, { timeoutMs: 90_000 }).then((r) => {
  process.stdout.write('HCPU ' + JSON.stringify({ ok: r.ok, error: r.error || null, picker: r.normal && r.normal.picker }) + '\\n');
}).catch((e) => process.stdout.write('HCPU ' + JSON.stringify({ ok: false, error: String(e && e.message || e) }) + '\\n'));
`;

/** Runs the real hidden App through the shipped helper, inside its named Job Object. */
async function renderedJob(exe, ask, dir, id, cap, { flip = false } = {}) {
  assert.deepEqual(await ask(`create ${id} 0 ${cap}`), { ok: true });
  const childPath = join(dir, 'child.cjs');
  writeFileSync(childPath, RECOVERY_CHILD);
  const child = spawn(exe, ['join', id, '0', `${cap};`, process.execPath, childPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: jailedEnv(dir) });
  let out = ''; let err = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (data) => { out += data; }); child.stderr.on('data', (data) => { err += data; });
  if (flip) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`rendered child never became ready: ${out} ${err}`)), 15_000);
      const ready = () => { if (out.includes('HCPU-READY')) { clearTimeout(timer); child.stdout.off('data', ready); resolve(); } };
      child.stdout.on('data', ready); ready();
    });
    assert.deepEqual(await ask(`set ${id} 0 0`), { ok: true }, 'the active App job accepts cap off');
    assert.deepEqual(await ask(`set ${id} 0 1`), { ok: true }, 'the active App job accepts cap on again');
  }
  await new Promise((resolve) => child.once('exit', resolve));
  const hit = /HCPU (\{.*\})/.exec(out);
  assert.ok(hit, `rendered child reply missing: ${out} ${err}`);
  const result = JSON.parse(hit[1]);
  assert.equal(result.ok, true, `real App recovery scenario in job: ${result.error}`);
  assert.equal(result.picker, true, 'the normal real App view rendered inside the job');
  assert.deepEqual(await ask(`close ${id}`), { ok: true });
}

test('RENDERED: a real App scenario starts inside an initially capped job (MUST-1)',
  { skip: process.platform !== 'win32' ? 'heavy jobs are Windows-only' : !existsSync(CSC) ? `no in-box csc at ${CSC}` : false, timeout: 150_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcpu-rendered-')); let serve;
    try {
      const exe = join(dir, 'guppy-heavyjob.exe');
      const compiled = spawnSync(CSC, ['-nologo', '-O', `-out:${exe}`, join(root, 'resources', 'heavyjob', 'guppy-heavyjob.cs')], { encoding: 'utf8', windowsHide: true });
      assert.equal(compiled.status, 0, `csc: ${compiled.stdout}${compiled.stderr}`);
      serve = spawn(exe, ['serve'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env: jailedEnv(dir) });
      const askLine = serveChannel(serve.stdout, (line) => serve.stdin.write(line));
      const ask = async (line) => JSON.parse(await askLine(line));
      await renderedJob(exe, ask, dir, `rendered-${process.pid}-${Date.now().toString(36)}`, 1);
    } finally { try { serve?.stdin.end(); } catch {} if (serve?.exitCode === null) await new Promise((resolve) => serve.once('exit', resolve)); rmSync(dir, { recursive: true, force: true }); }
  });

test('RENDERED: cap on/off/on flips while a real App job is alive (MUST-1)',
  { skip: process.platform !== 'win32' ? 'heavy jobs are Windows-only' : !existsSync(CSC) ? `no in-box csc at ${CSC}` : false, timeout: 150_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcpu-flip-')); let serve;
    try {
      const exe = join(dir, 'guppy-heavyjob.exe');
      const compiled = spawnSync(CSC, ['-nologo', '-O', `-out:${exe}`, join(root, 'resources', 'heavyjob', 'guppy-heavyjob.cs')], { encoding: 'utf8', windowsHide: true });
      assert.equal(compiled.status, 0, `csc: ${compiled.stdout}${compiled.stderr}`);
      serve = spawn(exe, ['serve'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env: jailedEnv(dir) });
      const askLine = serveChannel(serve.stdout, (line) => serve.stdin.write(line));
      const ask = async (line) => JSON.parse(await askLine(line));
      await renderedJob(exe, ask, dir, `flip-${process.pid}-${Date.now().toString(36)}`, 1, { flip: true });
    } finally { try { serve?.stdin.end(); } catch {} if (serve?.exitCode === null) await new Promise((resolve) => serve.once('exit', resolve)); rmSync(dir, { recursive: true, force: true }); }
  });

test('LIVE: a measured sub-ceiling cap reduces available busy throughput, then the job recovers uncapped (M10)',
  { skip: process.platform !== 'win32' ? 'heavy jobs are Windows-only' : !existsSync(CSC) ? `no in-box csc at ${CSC}` : false, timeout: 120_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcpu-throughput-'));
    let serve;
    try {
      const exe = join(dir, 'guppy-heavyjob.exe');
      const compiled = spawnSync(CSC, ['-nologo', '-O', `-out:${exe}`, join(root, 'resources', 'heavyjob', 'guppy-heavyjob.cs')], { encoding: 'utf8', windowsHide: true });
      assert.equal(compiled.status, 0, `csc: ${compiled.stdout}${compiled.stderr}`);
      serve = spawn(exe, ['serve'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env: jailedEnv(dir) });
      const askLine = serveChannel(serve.stdout, (line) => serve.stdin.write(line));
      const ask = async (line) => JSON.parse(await askLine(line));
      const worker = "const {parentPort,workerData}=require('node:worker_threads');const gate=new Int32Array(workerData.gate);parentPort.postMessage('ready');Atomics.wait(gate,0,0);const end=Date.now()+workerData.ms;let n=0;while(Date.now()<end){n++;}parentPort.postMessage(n)";
      const processors = availableParallelism();
      const busy = (workers) => `const {Worker}=require('node:worker_threads');const source=${JSON.stringify(worker)},gate=new SharedArrayBuffer(4),list=Array.from({length:${workers}},()=>new Worker(source,{eval:true,workerData:{gate,ms:4000}}));let ready=0,counts=[],w,c;for(const x of list)x.on('message',(m)=>{if(m==='ready'){if(++ready===list.length){w=Date.now();c=process.cpuUsage();Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0)}}else if(counts.push(m)===list.length){const u=process.cpuUsage(c);console.log(JSON.stringify({wall:Date.now()-w,cpu:(u.user+u.system)/1000,work:counts.reduce((a,n)=>a+n,0)}))}})`;
      const run = async (cap, rate = 5000, workers = processors) => {
        const id = `rate-${process.pid}-${Date.now().toString(36)}-${cap}`;
        assert.deepEqual(await ask(`create ${id} 0 ${cap}${cap ? ` ${rate}` : ''}`), { ok: true });
        const child = spawn(exe, ['join', id, '0', `${cap};`, process.execPath, '-e', busy(workers)], { encoding: 'utf8', windowsHide: true, env: jailedEnv(dir) });
        let out = ''; child.stdout.on('data', (d) => { out += d; });
        await new Promise((resolve) => child.once('exit', resolve));
        assert.deepEqual(await ask(`close ${id}`), { ok: true });
        return JSON.parse(out.trim());
      };
      const quarterId = `query-rate-${process.pid}-${Date.now().toString(36)}`;
      assert.deepEqual(await ask(`create ${quarterId} 0 1 2500`), { ok: true });
      assert.deepEqual(await ask(`query ${quarterId}`), { ok: true, background: false, cap: true, rate: 2500, affinity: null });
      assert.deepEqual(await ask(`close ${quarterId}`), { ok: true });
      const badId = `${quarterId}-bad`;
      assert.equal((await ask(`create ${badId} 0 1 nope`)).ok, false);
      assert.equal((await ask(`query ${badId}`)).ok, false, 'a bad rate must not leave a held job');
      await run(0); // warm the worker source before measuring either side of the comparison
      const ceiling = await run(0);
      // The runner's own heavy job (legacy half-cores affinity or priority) can already bound this
      // control; size the control to the measured ceiling, then set a hard cap near a quarter of it.
      // Turbo makes loop work nonlinear, so CPU time per wall second is the assertion.
      const workerCount = Math.max(1, Math.round(ceiling.cpu / ceiling.wall));
      const open = await run(0, 5000, workerCount);
      const capRate = Math.max(100, Math.floor(open.cpu / open.wall / processors * 2500));
      const capped = await run(1, capRate, workerCount);
      const openCpuRate = open.cpu / open.wall;
      const cappedCpuRate = capped.cpu / capped.wall;
      const targetCpuRate = processors * capRate / 10000;
      assert.ok(cappedCpuRate <= openCpuRate * 0.6, `cap did not reduce CPU rate: open=${JSON.stringify(open)} capped=${JSON.stringify(capped)} rate=${capRate}`);
      assert.ok(cappedCpuRate <= targetCpuRate * 1.25, `cap exceeded requested CPU rate: target=${targetCpuRate} open=${JSON.stringify(open)} capped=${JSON.stringify(capped)} rate=${capRate}`);
      console.log(`M10 ratios work=${(open.work / capped.work).toFixed(3)} cpu=${(cappedCpuRate / openCpuRate).toFixed(3)} target=${targetCpuRate.toFixed(3)} actual=${cappedCpuRate.toFixed(3)} rate=${capRate} workers=${workerCount}`);
    } finally {
      try { serve?.stdin.end(); } catch { /* gone */ }
      if (serve?.exitCode === null) await new Promise((resolve) => serve.once('exit', resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  });
