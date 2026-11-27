'use strict';
require('../tools/own-job.cjs');
/**
 * FLAKE-HEAVY-CPU-OPTIONS-191-B1: the LIVE Bash join cell (B1) of test/heavy-cpu-options-191.test.cjs,
 * in the SERIAL PERF LANE (test/tools/run-tests.cjs runs every test/perf/*.perf.cjs with
 * --test-concurrency=1, after the parallel suite).
 *
 * Why a lane of its own: the cell holds a 30 s wall-clock bound over about 20 process starts, one
 * after another (one PowerShell, the helper's serve, five Git Bash login shells, about thirteen
 * helper starts, two node). Alone the whole cell takes 3.3-3.8 s. In the parallel suite every start
 * was 10 to 25 times slower: a login shell 1.3-3.9 s against 150 ms, one helper start 1.3-1.4 s
 * against 57 ms, the PowerShell read up to 6.25 s against 0.7 s. The cell then took 23.9 s in the
 * Node leg and timed out at 30 s in the Electron leg (one full suite, step clock on). The bound
 * measured the machine, not the helper. The cell is unchanged: the same 30 s bound, the same sleeps,
 * the same asserts, the same step clock. test/heavy-cpu-options-191.test.cjs pins that it lives here.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('LIVE Bash join keeps its marker for repeated, sibling and background self-queries without LOCALAPPDATA residue (B1)',
  { skip: process.platform !== 'win32' || !fs.existsSync(path.join(__dirname, '..', '..', 'resources', 'heavyjob', 'bin', 'guppy-heavyjob.exe')) ? 'Windows helper not built' : false, timeout: 30_000 },
  async (t) => {
    const { spawn, spawnSync } = require('node:child_process');
    // Step clock (diagnostic only, nothing asserts on it): each line is recorded as its step ends
    // and printed with this test's report, so a run that reaches the test timeout still shows the
    // steps finished before it (later steps are lost). The first step also holds the mkdtemp, and
    // the first bash step's lap also holds the serve spawn and the create ask.
    const clockStart = performance.now(); let lap = clockStart;
    const step = (name, detail = '') => {
      const now = performance.now();
      t.diagnostic(`B1 step ${name}: ${Math.round(now - lap)} ms (at ${Math.round(now - clockStart)} ms)${detail}`);
      lap = now;
    };
    const exe = path.join(__dirname, '..', '..', 'resources', 'heavyjob', 'bin', 'guppy-heavyjob.exe');
    const bash = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
    if (!fs.existsSync(bash)) return;
    const id = `hcpu-b1-${process.pid}`;
    const markerJail = fs.mkdtempSync(path.join(os.tmpdir(), 'hcpu-markers-'));
    const env = { ...process.env, LOCALAPPDATA: markerJail };
    const knownLocal = spawnSync('powershell.exe', ['-NoProfile', '-Command', '[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)'], { encoding: 'utf8', env: require('../tools/ps-env.cjs').psEnv(process.env), windowsHide: true }).stdout.trim();
    step('powershell known-folder read');
    const knownRoot = path.join(knownLocal, 'Munder Difflin', 'Guppy', 'heavyjob-markers');
    const quote = (s) => `'${s.replace(/'/g, "'\\\"'\\\"'")}'`;
    const expected = { background: false, cap: true, rate: 5000, affinity: null };
    const serve = spawn(exe, ['serve'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env });
    let buffer = ''; const replies = [];
    serve.stdout.setEncoding('utf8');
    serve.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (/"event"/.test(line)) continue;
        const resolve = replies.shift(); if (resolve) resolve(JSON.parse(line));
      }
    });
    const ask = (line) => new Promise((resolve) => { replies.push(resolve); serve.stdin.write(`${line}\n`); });
     const assertQueries = async (line, count) => {
      const name = `${id}-${count}`;
      assert.deepEqual(await ask(`create ${name} 0 1`), { ok: true });
      try {
        // The three stamps go to stderr from a bash builtin (no extra process) and the line's own
        // exit status is passed on, so stdout and the status the asserts read are unchanged.
        const stamp = 'echo "T $EPOCHREALTIME" >&2';
        const spawned = Date.now();
        const r = spawnSync(bash, ['-lc', `${stamp}; ${quote(exe)} join ${name} 0 1; ${stamp}; ${line}; s=$?; ${stamp}; exit $s`], { encoding: 'utf8', windowsHide: true, env });
        const returned = Date.now();
        const at = (String(r.stderr).match(/^T [\d.,]+/gm) || []).map((s) => Math.round(Number(s.slice(2).replace(',', '.')) * 1000));
        step(`bash line with ${count} self-queries`, at.length === 3
          ? `: spawn to shell ready ${at[0] - spawned} ms, join ${at[1] - at[0]} ms, queries ${at[2] - at[1]} ms, shell exit ${returned - at[2]} ms`
          : `: ${at.length} of 3 stamps read`);
        assert.equal(r.status, 0, r.stderr);
        const rows = r.stdout.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
        assert.equal(rows.length, count, r.stdout);
        for (const row of rows) assert.deepEqual(row, expected, r.stderr);
       } finally { assert.deepEqual(await ask(`close ${name}`), { ok: true }); }
     };
    const waitReady = (child) => new Promise((resolve, reject) => {
      let out = '';
      const fail = (e) => reject(new Error(`held shell did not become ready: ${e.message || e}\n${out}`));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => { out += d; child.hcpuOutput = out; if (out.includes('READY\n')) resolve(out); });
      child.once('error', fail);
      child.once('exit', (code) => { if (!out.includes('READY\n')) fail(`exit ${code}`); });
    });
    const waitExit = (child) => new Promise((resolve) => child.exitCode === null ? child.once('exit', resolve) : resolve());
    const heldShell = (name, cap, queryFile) => {
      const program = queryFile
        ? `echo READY; sleep 1; ${quote(exe)} self-query > ${quote(queryFile)}`
        : 'echo READY; sleep 2';
      return spawn(bash, ['-lc', `${quote(exe)} join ${name} 0 ${cap ? 1 : 0}; ${program}`], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    };
    let capName; let uncappedName; let capped; let uncapped;
    try {
      // The same shell, two separately spawned Node processes, and a background command all find
      // the still-live shell marker.  A marker is lifetime state, not a one-shot query token.
      await assertQueries(`${quote(exe)} self-query; ${quote(exe)} self-query; ${quote(exe)} self-query`, 3);
      const nodeExe = exe.replace(/\\/g, '/');
      const nodeQuery = `${quote(process.execPath)} -e ${quote(`process.stdout.write(require("node:child_process").execFileSync(${JSON.stringify(nodeExe)}, ["self-query"], {encoding:"utf8"}))`)}`;
       await assertQueries(`${nodeQuery}; ${nodeQuery}`, 2);
       await assertQueries(`${quote(exe)} self-query; ${quote(exe)} self-query & wait`, 2);
       // A marker folder is shared by this Windows user, so only membership of the querying child
       // can select it.  Hold a cap live and prove an unrelated process does not borrow it.
       capName = `${id}-live-cap`; uncappedName = `${id}-live-uncapped`;
       assert.deepEqual(await ask(`create ${capName} 0 1`), { ok: true });
       assert.deepEqual(await ask(`create ${uncappedName} 0 0`), { ok: true });
        const markerRoot = path.join(markerJail, 'Munder Difflin', 'Guppy', 'heavyjob-markers');
       try {
         const queryFile = path.join(process.env.TEMP || os.tmpdir(), `${capName}.json`);
          capped = heldShell(capName, true, queryFile); await waitReady(capped);
          step('capped held shell: spawn to READY (shell start + join)');
          assert.ok(fs.existsSync(markerRoot), 'the held native helper writes markers inside this file\'s jailed LocalAppData');
         const unrelated = JSON.parse(spawnSync(exe, ['self-query'], { encoding: 'utf8', windowsHide: true, env }).stdout.trim());
         step('unrelated self-query (one helper process, no shell)');
         assert.equal(unrelated.cap, false, 'an unrelated process cannot take another shell\'s capped marker');
         uncapped = heldShell(uncappedName, false, false); await waitReady(uncapped);
         step('uncapped held shell: spawn to READY (shell start + join)');
         await waitExit(capped);
         step('capped shell exit (the rest of its sleep 1 + one self-query)');
         const row = JSON.parse(fs.readFileSync(queryFile, 'utf8'));
         fs.rmSync(queryFile, { force: true });
         assert.deepEqual(row, expected, 'a capped caller ignores a newer live uncapped marker');
       } finally {
         if (capped && capped.exitCode === null) capped.kill();
         if (uncapped && uncapped.exitCode === null) uncapped.kill();
         await Promise.all([capped, uncapped].filter(Boolean).map(waitExit));
         step('held shells killed and exited');
         assert.deepEqual(await ask(`close ${capName}`), { ok: true });
         assert.deepEqual(await ask(`close ${uncappedName}`), { ok: true });
         step('close both held jobs');
       }
     } finally {
       try { serve.stdin.end(); } catch { /* gone */ }
       if (serve.exitCode === null) await new Promise((resolve) => serve.once('exit', resolve));
       step('serve exit');
       fs.rmSync(markerJail, { recursive: true, force: true });
       step('marker jail removed');
     }
    // Do not snapshot/diff another user's shared marker folder: only this test's identifiers matter.
    // B1-MARKER-LEAK-CHECK-SUBSTRING-MATCH-108: they match as whole fields (a marker name's pid
    // field, a body's job id), never as substrings, so a foreign marker whose creation-time tail
    // holds a pid's digits is not a leak (test/tools/b1-marker-leak.cjs). A red names the token,
    // where it matched and the forbidden list. A foreign marker its own helper deleted between the
    // listing and the read (ENOENT) is skipped; any other read error still fails.
    const { markerLeaks } = require('../tools/b1-marker-leak.cjs');
    const marks = { id, names: [capName, uncappedName].filter(Boolean), pids: [capped?.pid, uncapped?.pid].filter(Boolean) };
    const knownFiles = fs.existsSync(knownRoot) ? fs.readdirSync(knownRoot) : [];
    const entries = [];
    for (const file of knownFiles) {
      try { entries.push({ file, body: fs.readFileSync(path.join(knownRoot, file), 'utf8') }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    const leaks = markerLeaks(entries, marks);
    const said = leaks.map(({ file, token, where }) => `jailed B1 leaked marker ${file} into real LocalAppData: ${where} matched ${JSON.stringify(token)}`);
    assert.ok(leaks.length === 0, `${said.join('\n')}\nforbidden: ${JSON.stringify(marks)} (in ${knownRoot})`);
  });
