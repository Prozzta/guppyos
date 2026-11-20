'use strict';
require('./tools/own-job.cjs');

// PTY-CONHOST-LEAK-NATIVE. Every Windows terminal has a console host process (conhost.exe, or
// OpenConsole.exe with the bundled conpty.dll), a child of the process that made the pseudoconsole.
// The host ends when the pseudoconsole is closed. node-pty 1.1.0 closes it only from its kill, and
// only while the terminal's record is still in the native list; its exit thread drops that record
// without closing. So a terminal that ended by itself kept its host, and so did a killed one,
// because PtyManager ends the process tree first and the exit thread wins. Measured 2026-11-19 on
// Node and on Electron as Node: one host per ended terminal, still there 15 s later, until the app
// quits.
//
// Measured here the same way: the host children of THIS process, by pid, before and after one
// terminal. The wait is on the state itself (the terminal's host pid is gone from the list); the
// bound is a count of completed listings after the terminal's exit was reported, not a time, and it
// names the host that stayed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { consoleNode } = require('./tools/console-node.cjs');

const WIN = process.platform === 'win32';
const HOSTS = new Set(['conhost.exe', 'openconsole.exe']);
const LISTINGS = 12;   // completed process listings after the exit before "it stays" is the verdict
let seq = 0;

/** pid -> name of the console hosts that are children of this process. */
function hostChildren() {
  const body = `$ProgressPreference = 'SilentlyContinue'\nGet-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`;
  return new Promise((res, rej) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(body, 'utf16le').toString('base64')],
      { encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
        if (err) { rej(new Error(`the process listing failed: ${err.message}\n${stderr}`)); return; }
        const hosts = new Map();
        for (const line of stdout.split(/\r?\n/)) {
          const m = /^(\d+) (.+)$/.exec(line.trim());
          if (m && HOSTS.has(m[2].toLowerCase())) hosts.set(Number(m[1]), m[2]);
        }
        res(hosts);
      });
  });
}

/** One terminal through the manager; `end` ends it. Resolves once its host is gone, or fails naming it. */
async function hostGoneAfter(t, script, end, how) {
  const { PtyManager } = loadTs('src/main/pty.ts');
  const node = consoleNode();
  t.diagnostic(`PTY child: ${node.file} ${node.version} (from ${node.from})`);
  const m = new PtyManager();
  const id = `conhost-leak-${process.pid}-${seq += 1}`;
  const before = await hostChildren();
  assert.deepEqual(await m.spawn({ id, cwd: process.cwd(), command: node.file, args: ['-e', script], cols: 80, rows: 24 }), { ok: true });
  const proc = m.sessions.get(id).proc;
  const exited = new Promise((res) => proc.onExit(res));
  const firstOutput = new Promise((res) => { const sub = proc.onData(() => { sub.dispose(); res(); }); });
  const mine = [...(await hostChildren())].filter(([pid]) => !before.has(pid));
  try {
    assert.equal(mine.length, 1, `the listing sees this terminal's console host: exactly one new host child, got ${JSON.stringify(mine)}`);
    await end({ m, id, proc, firstOutput });
    await exited;
    let left = mine;
    for (let n = 0; n < LISTINGS && left.length; n += 1) {
      const now = await hostChildren();
      left = mine.filter(([pid]) => now.has(pid));
    }
    assert.deepEqual(left, [], `THE CONSOLE HOST OUTLIVES ITS TERMINAL: ${how}, and ${LISTINGS} listings after the exit was reported `
      + `${left.map(([pid, name]) => `${name} pid ${pid}`).join(', ')} is still a child of this process (the pseudoconsole was never closed)`);
  } finally {
    if (m.sessions.has(id)) m.kill(id);
    for (const [pid] of mine) { try { process.kill(pid); } catch { /* gone, as it should be */ } }
  }
}

test('PTY-CONHOST-LEAK: a terminal whose program ends by itself releases its console host', { skip: !WIN, timeout: 120_000 }, async (t) => {
  // The child ends when a flag file appears, so the first listing is taken while it is certainly alive.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conhost-leak-'));
  const flag = path.join(dir, 'end');
  try {
    await hostGoneAfter(t, `const fs = require('fs'); setInterval(() => { if (fs.existsSync(${JSON.stringify(flag)})) process.exit(0); }, 50)`,
      async () => { fs.writeFileSync(flag, ''); }, 'the program ended by itself (no kill was sent)');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PTY-CONHOST-LEAK: a terminal ended by PtyManager.kill releases its console host', { skip: !WIN, timeout: 120_000 }, async (t) => {
  await hostGoneAfter(t, 'setInterval(() => {}, 1000)', async ({ m, id }) => { assert.deepEqual(m.kill(id), { ok: true }); },
    'PtyManager.kill ended it');
});

test('PTY-CONHOST-LEAK: a terminal killed while its program floods output releases its console host', { skip: !WIN, timeout: 120_000 }, async (t) => {
  // The host has output in hand when the close arrives: the close must not wait on it for ever.
  const flood = "const b = 'x'.repeat(4096) + '\\n'; const w = () => { while (process.stdout.write(b)); process.stdout.once('drain', w); }; w();";
  await hostGoneAfter(t, flood, async ({ m, id, firstOutput }) => { await firstOutput; assert.deepEqual(m.kill(id), { ok: true }); },
    'PtyManager.kill ended it while it was printing');
});
