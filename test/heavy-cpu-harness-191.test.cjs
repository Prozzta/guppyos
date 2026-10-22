// @heavy-lock live: compiles and invokes the shipped Windows Job Object helper.
/** HALFCORES-OVERSUBSCRIBE: live native proof of CPU-rate hard-cap mode and live application. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, relative } = require('node:path');

const root = join(__dirname, '..');
const CSC = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

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

test('LIVE: a fresh cap-off job creates and joins, then cap on/off/on applies to the held job (M1/M8/M9)',
  { skip: process.platform !== 'win32' ? 'heavy jobs are Windows-only' : !existsSync(CSC) ? `no in-box csc at ${CSC}` : false, timeout: 120_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcpu-rate-'));
    let serve;
    try {
      const exe = join(dir, 'guppy-heavyjob.exe');
      const compiled = spawnSync(CSC, ['-nologo', '-O', `-out:${exe}`, join(root, 'resources', 'heavyjob', 'guppy-heavyjob.cs')], { encoding: 'utf8', windowsHide: true });
      assert.equal(compiled.status, 0, `csc: ${compiled.stdout}${compiled.stderr}`);
      serve = spawn(exe, ['serve'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      let buffer = '';
      const replies = [];
      serve.stdout.setEncoding('utf8');
      serve.stdout.on('data', (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const resolve = replies.shift();
          if (resolve) resolve(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
      });
      const request = (line) => new Promise((resolve) => { replies.push(resolve); serve.stdin.write(`${line}\n`); }).then((line) => JSON.parse(line));
      const id = `rate-${process.pid}-${Date.now().toString(36)}`;
      const offId = `${id}-off`;
      assert.deepEqual(await request(`create ${offId} 0 0`), { ok: true }, 'fresh cap-off must not call class 15 with flags zero');
      assert.deepEqual(await request(`query ${offId}`), { ok: true, background: false, cap: false, rate: 0, affinity: null });
      const joinedOff = spawnSync(exe, ['join', offId, '0', '0'], { encoding: 'utf8', windowsHide: true });
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
async function renderedJob(exe, ask, id, cap, { flip = false } = {}) {
  assert.deepEqual(await ask(`create ${id} 0 ${cap}`), { ok: true });
  const child = spawn(exe, ['join', id, '0', `${cap};`, process.execPath, '-e', RECOVERY_CHILD], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
      serve = spawn(exe, ['serve'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      let buffer = ''; const replies = [];
      serve.stdout.setEncoding('utf8'); serve.stdout.on('data', (data) => { buffer += data; let at; while ((at = buffer.indexOf('\n')) >= 0) { replies.shift()?.(buffer.slice(0, at)); buffer = buffer.slice(at + 1); } });
      const ask = (line) => new Promise((resolve) => { replies.push(resolve); serve.stdin.write(`${line}\n`); }).then((line) => JSON.parse(line));
      await renderedJob(exe, ask, `rendered-${process.pid}-${Date.now().toString(36)}`, 1);
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
      serve = spawn(exe, ['serve'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      let buffer = ''; const replies = [];
      serve.stdout.setEncoding('utf8'); serve.stdout.on('data', (data) => { buffer += data; let at; while ((at = buffer.indexOf('\n')) >= 0) { replies.shift()?.(buffer.slice(0, at)); buffer = buffer.slice(at + 1); } });
      const ask = (line) => new Promise((resolve) => { replies.push(resolve); serve.stdin.write(`${line}\n`); }).then((line) => JSON.parse(line));
      await renderedJob(exe, ask, `flip-${process.pid}-${Date.now().toString(36)}`, 1, { flip: true });
    } finally { try { serve?.stdin.end(); } catch {} if (serve?.exitCode === null) await new Promise((resolve) => serve.once('exit', resolve)); rmSync(dir, { recursive: true, force: true }); }
  });

test('LIVE: sixteen busy threads get about half their available throughput when the job is capped, then recover uncapped (M10)',
  { skip: process.platform !== 'win32' ? 'heavy jobs are Windows-only' : !existsSync(CSC) ? `no in-box csc at ${CSC}` : false, timeout: 120_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcpu-throughput-'));
    let serve;
    try {
      const exe = join(dir, 'guppy-heavyjob.exe');
      const compiled = spawnSync(CSC, ['-nologo', '-O', `-out:${exe}`, join(root, 'resources', 'heavyjob', 'guppy-heavyjob.cs')], { encoding: 'utf8', windowsHide: true });
      assert.equal(compiled.status, 0, `csc: ${compiled.stdout}${compiled.stderr}`);
      serve = spawn(exe, ['serve'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      let buffer = ''; const replies = [];
      serve.stdout.setEncoding('utf8');
      serve.stdout.on('data', (chunk) => { buffer += chunk; let at; while ((at = buffer.indexOf('\n')) >= 0) { replies.shift()?.(buffer.slice(0, at)); buffer = buffer.slice(at + 1); } });
      const ask = (line) => new Promise((resolve) => { replies.push(resolve); serve.stdin.write(`${line}\n`); }).then((line) => JSON.parse(line));
      const worker = "const {parentPort,workerData}=require('node:worker_threads');let n=0;while(Date.now()<workerData){n++;}parentPort.postMessage(n)";
      const busy = `const {Worker}=require('node:worker_threads');const source=${JSON.stringify(worker)},end=Date.now()+2500,w=Date.now(),c=process.cpuUsage();Promise.all(Array.from({length:16},()=>new Promise(r=>new Worker(source,{eval:true,workerData:end}).once('message',r)))).then(()=>{const u=process.cpuUsage(c);console.log(JSON.stringify({wall:Date.now()-w,cpu:(u.user+u.system)/1000}))})`;
      const run = async (cap) => {
        const id = `rate-${process.pid}-${Date.now().toString(36)}-${cap}`;
        assert.deepEqual(await ask(`create ${id} 0 ${cap}`), { ok: true });
        const child = spawn(exe, ['join', id, '0', `${cap};`, process.execPath, '-e', busy], { encoding: 'utf8', windowsHide: true });
        let out = ''; child.stdout.on('data', (d) => { out += d; });
        await new Promise((resolve) => child.once('exit', resolve));
        assert.deepEqual(await ask(`close ${id}`), { ok: true });
        return JSON.parse(out.trim());
      };
      const capped = await run(1); const open = await run(0);
      // CPU rate is a percentage of one processor, even though the child deliberately
      // has enough workers to consume every visible processor when no cap is present.
      const ratio = (r) => r.cpu / r.wall;
      assert.ok(ratio(capped) > 0.30 && ratio(capped) < 0.70, `cap throughput ${ratio(capped).toFixed(2)} (expected ~0.50): ${JSON.stringify(capped)}`);
      assert.ok(ratio(open) > 0.75, `uncapped throughput ${ratio(open).toFixed(2)} (expected ~1): ${JSON.stringify(open)}`);
    } finally {
      try { serve?.stdin.end(); } catch { /* gone */ }
      if (serve?.exitCode === null) await new Promise((resolve) => serve.once('exit', resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  });
