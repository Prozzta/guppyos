'use strict';
/**
 * GUPPY-NODE-LTS (god 57be0d): the runner's own per-file backstop, the record half.
 *
 * run-tests.cjs loads this into its `node --test` through NODE_OPTIONS. In a test-file process
 * (NODE_TEST_CONTEXT child) it appends one row to GUPPY_FILE_BACKSTOP: { pid, bornMs, file, name },
 * where bornMs is a time taken while this process is alive (own-procs' rule: the process created at
 * or before it under this pid and name is this one). On a normal exit it appends { pid, exited }.
 * file-backstop.cjs reads the rows and kills a file still running past the backstop.
 *
 * It takes itself back out of NODE_OPTIONS (as file-job-preload does), so a process the file starts
 * is not recorded as a file of the run. The backstop no longer rests on `node --test --test-timeout`:
 * from Node 22/24 that times out TESTS only, and a file whose tests passed but which never exits
 * was never killed (Node 20 killed it at the timeout).
 */
const out = process.env.GUPPY_FILE_BACKSTOP;
const opt = process.env.GUPPY_FILE_BACKSTOP_OPT; // the exact text run-tests added to NODE_OPTIONS
if (out && opt && String(process.env.NODE_TEST_CONTEXT || '').startsWith('child')) {
  process.env.NODE_OPTIONS = String(process.env.NODE_OPTIONS || '').replace(opt, '').trim();
  if (!process.env.NODE_OPTIONS) delete process.env.NODE_OPTIONS;
  delete process.env.GUPPY_FILE_BACKSTOP;
  delete process.env.GUPPY_FILE_BACKSTOP_OPT;
  const fs = require('fs');
  const pid = process.pid;
  // own-procs.bornNow(), inline: this runs in every file, so it loads nothing it does not need.
  const bornMs = Math.round(Date.now() - process.uptime() * 1000);
  const name = require('path').basename(process.execPath);
  try { fs.appendFileSync(out, `${JSON.stringify({ pid, bornMs, file: process.argv[1] || '', name })}\n`); } catch { /* the watchdog still covers it */ }
  process.on('exit', () => { try { fs.appendFileSync(out, `${JSON.stringify({ pid, exited: true, endMs: Date.now() })}\n`); } catch { /* noop */ } });

  // CLAIMS-LEDGER-W6-SILENT-EXIT: a kill by pid NUMBER can end a stranger that got the number after
  // its owner died; the stranger (another test file) then ends with exit code 1 and not one line of
  // output. Each kill this file makes by number (process.kill with a real signal, or a taskkill it
  // starts) is one row in <out>.kills: { pid, file, via, targets, t }. The runner reads the rows only
  // for a file that ended without its exit row above, to name the kill that hit it. Nothing is
  // blocked or changed: the real call runs with the caller's arguments. Not recorded: a kill made
  // by a process the file starts (this preload is not in it), and a kill by handle (no number).
  const killsOut = `${out}.kills`;
  const file = process.argv[1] || '';
  const note = (via, targets) => {
    const t = targets.map(Number).filter((n) => Number.isInteger(n) && n !== 0).map(Math.abs);
    if (!t.length) return;
    try { fs.appendFileSync(killsOut, `${JSON.stringify({ pid, file, via, targets: t, t: Date.now() })}\n`); } catch { /* the kill itself still runs */ }
  };
  const realKill = process.kill;
  process.kill = function kill(target, signal) {
    if (signal !== 0 && signal !== '0') note('process.kill', [target]);
    return realKill.apply(this, arguments);
  };
  const taskkillPids = (cmd, args) => {
    const text = [String(cmd), ...(Array.isArray(args) ? args.map(String) : [])].join(' ');
    if (!/taskkill/i.test(text)) return [];
    return [...text.matchAll(/\/pid\s+"?(\d+)/gi)].map((m) => m[1]);
  };
  const cp = require('child_process');
  const custom = require('util').promisify.custom;
  const wrap = (real) => function (cmd, args) {
    try { note('taskkill', taskkillPids(cmd, args)); } catch { /* the call itself still runs */ }
    return real.apply(this, arguments);
  };
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) {
    const real = cp[name];
    if (typeof real !== 'function') continue;
    const w = wrap(real);
    // name, length and util.promisify's own form stay what callers and tests read off the real one
    const descs = Object.getOwnPropertyDescriptors(real);
    if (descs[custom] && typeof descs[custom].value === 'function') descs[custom] = { ...descs[custom], value: wrap(descs[custom].value) };
    Object.defineProperties(w, descs);
    cp[name] = w;
  }
  try { require('module').syncBuiltinESMExports(); } catch { /* require() callers are covered */ }
}
