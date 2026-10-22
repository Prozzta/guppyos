// @heavy-lock live: compiles and invokes the shipped Windows Job Object helper.
/** HALFCORES-OVERSUBSCRIBE: live native proof of CPU-rate hard-cap mode and live application. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { existsSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const root = join(__dirname, '..');
const CSC = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

test('LIVE: the helper queries 50% hard-cap mode, then applies an on/off/on change to the held job (M1/M8)',
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
