'use strict';
require('./tools/own-job.cjs');
/**
 * PTY-CONHOST-ORPHAN-OWNER-DEATH (Andy 2026-11-19): when the process that owns a ConPTY dies
 * abruptly (TerminateProcess, ExitProcess, process.reallyExit: no ClosePseudoConsole) while a client
 * on the pseudo-console still holds its console handles, the inbox conhost (10.0.19041, node-pty's
 * default host) ends the clients and then parks forever: 6 threads in Wait, 0 CPU, parent gone.
 * Nothing in Guppy ever reaps it, and it outlives Guppy itself. Measured: live client + abrupt owner
 * death orphaned it 15/15 under node-pty; an ended client (6/6) and a live owner's ClosePseudoConsole
 * stayed clean. The std handles node-pty passes do not decide it (stage-1 correction).
 *
 * REAL processes, headless: a node OWNER loads Guppy's PtyManager (src/main/pty.ts) and spawns a PTY
 * running cmd.exe + ping (a live console client). The test snapshots the owner's console host
 * (conhost.exe or OpenConsole.exe, whichever pty.ts uses) while the owner is alive, then tells the
 * owner to process.reallyExit, which skips every exit handler, as a crash or an external kill does.
 * The host must be gone within HOST_GONE_MS. The owner joins no job of its own: a job there would end
 * the host by itself and hide the bug. Everything still runs inside this file's own kill-on-close job
 * (own-job.cjs), so a failed run never leaks past the file; the finally also reaps by verified record.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
// MUTANT-JOURNAL NO-BYPASS: tools/test-temp.cjs is mutated in place by the temp-hygiene census; refuse a
// tree a mutant runner left (or is holding) mutated, like load-ts does.
const REPO = path.join(__dirname, '..');
require('./tools/mutant-runner-helper.cjs').assertUnmutated(REPO, path.basename(__filename));
const { tempDir } = require('./tools/test-temp.cjs');
const { processTable, lookupPids, childrenOf, treeOf, sameProcess, killVerified } = require('./tools/own-procs.cjs');

if (process.platform !== 'win32') {
  require('./tools/inert.cjs').announceInert('PTY-CONHOST-ORPHAN owner death', 'ConPTY console hosts are Windows only');
  return;
}

/** Clean hosts went in 2.3-3.9 s after the owner's death (OpenConsole, n=8); the clients of an
 *  orphaned inbox conhost went in under 4.4 s while it stayed. 15 s is far past both. */
const HOST_GONE_MS = 15_000;
/** The client is up and its output connected (the measured cells held 1.5 s and 4 s). */
const CLIENT_UP_MS = 1_500;
const HOST_NAME = /^(conhost|openconsole)\.exe$/i;
const DIR = tempDir('conorph-');
const LOAD_TS = path.join(__dirname, 'load-ts.cjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.writeFileSync(path.join(DIR, 'client.bat'), '@echo off\r\nping -n 60 127.0.0.1 >nul\r\n');
fs.writeFileSync(path.join(DIR, 'owner.js'), [
  "'use strict';",
  "const fs = require('fs'); const path = require('path');",
  'const dir = process.argv[2];',
  `const { PtyManager } = require(${JSON.stringify(LOAD_TS)})('src/main/pty.ts');`,
  '(async () => {',
  '  const m = new PtyManager();',
  "  const r = await m.spawn({ id: 'conorph', cwd: dir, command: 'cmd.exe', args: ['/d', '/c', path.join(dir, '..', 'client.bat')], cols: 80, rows: 24, env: {} }, { isDestroyed: () => false, send: () => {} });",
  '  const row = m.list()[0];',
  "  fs.writeFileSync(path.join(dir, 'owner.json.tmp'), JSON.stringify({ ok: r.ok, error: r.error || null, root: row ? row.pid : 0 }));",
  "  fs.renameSync(path.join(dir, 'owner.json.tmp'), path.join(dir, 'owner.json'));",
  // the abrupt death: no exit handlers, no ClosePseudoConsole. 60 s cap so a lost test never leaves it.
  '  const t0 = Date.now();',
  "  setInterval(() => { if (fs.existsSync(path.join(dir, 'go')) || Date.now() - t0 > 60000) process.reallyExit(3); }, 25);",
  "})().catch((e) => { fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ ok: false, error: String(e && e.stack || e) })); process.reallyExit(4); });"
].join('\n'));

test.after(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

const isLive = (rec) => lookupPids([rec.pid]).some((r) => sameProcess(r, rec));

test('PTY-CONHOST-ORPHAN: the console host of a PTY ends when its owner dies abruptly with a live client', async () => {
  const dir = fs.mkdtempSync(path.join(DIR, 'run-'));
  const owner = spawn(process.execPath, [path.join(DIR, 'owner.js'), dir], { cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    // DETACHED_PROCESS: no console of its own, as Electron's main has none; else its own conhost
    // is a second console host child and the count below cannot tell which one is the PTY's.
    detached: true });
  let ownerErr = '';
  owner.stderr.on('data', (d) => { ownerErr += d; });
  const ownerExit = new Promise((r) => owner.once('exit', (code) => r(code)));
  const recs = [];
  try {
    const ownerRec = lookupPids([owner.pid])[0];
    assert.ok(ownerRec, 'the owner is running');
    recs.push(ownerRec);
    const ready = path.join(dir, 'owner.json');
    for (let i = 0; i < 600 && !fs.existsSync(ready); i++) await sleep(25);
    assert.ok(fs.existsSync(ready), `the owner spawned its PTY within 15 s (stderr: ${ownerErr.slice(0, 400)})`);
    const st = JSON.parse(fs.readFileSync(ready, 'utf8'));
    assert.ok(st.ok, `spawn: ${st.error}`);
    await sleep(CLIENT_UP_MS);

    const rows = processTable();
    const hosts = childrenOf(rows, ownerRec).filter((r) => HOST_NAME.test(r.name));
    assert.equal(hosts.length, 1, `the owner has one console host while alive: ${JSON.stringify(childrenOf(rows, ownerRec))}`);
    const host = hosts[0];
    const client = rows.find((r) => r.pid === st.root && r.ppid === ownerRec.pid);
    assert.ok(client && /^cmd\.exe$/i.test(client.name), `the PTY root is the live cmd.exe client: ${JSON.stringify(client)}`);
    const clientTree = [client, ...treeOf(rows, client)];
    recs.push(host, ...clientTree);
    assert.ok(clientTree.some((r) => /^ping\.exe$/i.test(r.name)), `the client is still running ping at the owner's death: ${JSON.stringify(clientTree)}`);

    fs.writeFileSync(path.join(dir, 'go'), '');
    const code = await ownerExit;
    assert.equal(code, 3, 'the owner died by process.reallyExit(3)');

    const t0 = Date.now();
    let hostLive = true;
    while (Date.now() - t0 < HOST_GONE_MS && (hostLive = isLive(host))) await sleep(250);
    const clientsLive = clientTree.filter(isLive).map((r) => `${r.name} ${r.pid}`);
    assert.equal(hostLive, false,
      `CONHOST ORPHAN: ${host.name} pid ${host.pid} (parent owner pid ${ownerRec.pid}, now dead) is still alive ${HOST_GONE_MS} ms after its ConPTY owner died; ` +
      `clients still alive: ${clientsLive.length ? clientsLive.join(', ') : 'none'}`);
  } finally {
    if (owner.exitCode === null) { try { fs.writeFileSync(path.join(dir, 'go'), ''); } catch { /* dir gone */ } }
    killVerified(recs.filter(isLive));
  }
});
