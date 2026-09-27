'use strict';

/**
 * EXIT-CRASH (Jim, EXIT-CRASH-WHY.md): a hidden Electron main that owns 4 REAL ConPTY sessions
 * (node-pty, cmd.exe), quits the way the app does, and exits at once. With the local crash
 * reporter on (dumps into the SANDBOX only), the parent counts the dumps:
 *   --mode old : tree kill + proc.kill, then app.exit (1.1.65-1.1.67): a node-pty exit callback
 *                lands during teardown -> Napi::Error -> a dump.
 *   --mode new : PtyManager.killAllAsync (waits for every exit, capped), then app.exit: no dump.
 * userData, sessionData and crashDumps all live in the sandbox; no window is created.
 */
const { app, crashReporter } = require('electron');
const { join } = require('node:path');
const { mkdirSync } = require('node:fs');

const argOf = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const sandbox = argOf('sandbox', null);
const mode = argOf('mode', 'new');
if (!sandbox) { process.stderr.write('pty-quit harness: --sandbox required\n'); process.exit(2); }
app.setPath('userData', sandbox);
app.setPath('sessionData', sandbox);
const dumps = join(sandbox, 'crashDumps');
mkdirSync(dumps, { recursive: true });
app.setPath('crashDumps', dumps);
crashReporter.start({ uploadToServer: false, submitURL: '', compress: false });

const loadTs = require(join(__dirname, '..', 'load-ts.cjs'));
const { PtyManager } = loadTs('src/main/pty.ts');
const { killTreesAsync } = loadTs('src/main/procKill.ts');
const pty = require('node-pty');

app.whenReady().then(async () => {
  const m = new PtyManager();
  const procs = [];
  for (let i = 0; i < 4; i += 1) {
    const p = pty.spawn('cmd.exe', ['/k'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: sandbox, env: process.env, useConpty: true });
    p.onData(() => {});
    procs.push(p);
    m.sessions.set(`t${i}`, { proc: p });
  }
  await new Promise((r) => setTimeout(r, 1500)); // let the shells come up
  const t0 = Date.now();
  if (mode === 'old') {
    const sessions = [...m.sessions.values()]; m.sessions.clear();
    await killTreesAsync(sessions.map((s) => s.proc.pid)).then(() => { for (const s of sessions) { try { s.proc.kill(); } catch { /* noop */ } } });
  } else {
    await m.killAllAsync();
  }
  process.stdout.write(`__PTYQUIT__${JSON.stringify({ mode, ms: Date.now() - t0, pending: m.exitsPending })}\n`);
  app.exit(0);
});
