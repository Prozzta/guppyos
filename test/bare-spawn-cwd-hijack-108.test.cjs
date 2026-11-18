'use strict';
require('./tools/own-job.cjs');
/**
 * BARE-SPAWN-CWD-HIJACK-108 (Jim's BARE-SPAWN-CENSUS, class B): cmd.exe looks for a bare command
 * in its CURRENT directory before PATH. A repo or agent workspace that holds an npm.bat or a
 * findstr.bat would have it run in place of the real tool:
 *   row 1: the missing-CLI installer (pty.ts shellScript, `ComSpec /d /s /c "<script>"`, cwd = the
 *          agent's workspace) runs `npm install -g ...` by a bare name;
 *   row 7: <hive>/bin/agy-oneway.cmd (hive.ts agyOnewayCmd) runs `findstr` by a bare name, in the
 *          AGY agent's workspace.
 * The fix sets NoDefaultCurrentDirectoryInExePath=1 inside cmd before those lookups, so cmd skips
 * its current directory (and the children cmd starts inherit it).
 *
 * Agent shells here inherit NoDefaultCurrentDirectoryInExePath from the Claude Code CLI, which hides
 * the hole; the packaged app does not set it. Every child here gets an env WITHOUT it, and each
 * test first proves the planted file runs on a bare call in that env.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const WIN = process.platform === 'win32';
const COMSPEC = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
const SYS32 = path.dirname(COMSPEC);

/** process.env without NoDefaultCurrentDirectoryInExePath (any case), as the packaged app runs. */
function appEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^NoDefaultCurrentDirectoryInExePath$/i.test(k)) env[k] = v;
  return { ...env, ...extra };
}

function jail(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bare108-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ws = path.join(dir, 'ws');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(ws); fs.mkdirSync(bin);
  return { dir, ws, bin };
}

const PLANT = '@echo off\r\necho BARE108-PLANTED\r\n';

test('row 1: the missing-CLI installer does not run an npm.bat planted in the workspace (cmd /d /s /c, the exact pty.ts command line)', { skip: !WIN }, (t) => {
  const { winShellScriptArgs } = loadTs('src/main/pty.ts');
  const { buildMissingCliScript } = loadTs('src/main/cliInstall.ts');
  const { ws, bin } = jail(t);
  fs.writeFileSync(path.join(ws, 'npm.bat'), PLANT);
  fs.writeFileSync(path.join(bin, 'npm.bat'), '@echo off\r\necho BARE108-REAL %*\r\n');
  const env = appEnv({ PATH: `${bin};${SYS32}` });
  const run = (args) => spawnSync(COMSPEC, [args], { cwd: ws, env, encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true, timeout: 30_000 });

  const proof = run('/d /s /c "npm"');
  assert.match(proof.stdout, /BARE108-PLANTED/, `precondition: without the variable a bare npm runs the planted file\n${proof.stdout}${proof.stderr}`);

  const script = buildMissingCliScript('claude', 'claude', true, 'win32');
  assert.match(script, /(^| & )npm install -g /, `precondition: the installer runs npm by a bare name: ${script}`);
  const r = run(winShellScriptArgs(script));
  assert.doesNotMatch(r.stdout, /BARE108-PLANTED/, `the workspace's npm.bat ran\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /BARE108-REAL install -g /, `the npm on PATH ran\n${r.stdout}${r.stderr}`);
});

test('row 7: agy-oneway.cmd does not run a findstr.bat planted in the AGY workspace; the real findstr carries the body to the pipe', { skip: !WIN }, async (t) => {
  const { agyOnewayCmd } = loadTs('src/main/hive.ts');
  const { ws, bin } = jail(t);
  fs.writeFileSync(path.join(ws, 'findstr.bat'), PLANT);
  const env = appEnv({ PATH: SYS32, HIVE_HOOK_TOKEN: 'tok108', AGENT_ID: 'agent108' });

  const proof = spawnSync(COMSPEC, ['/d /s /c "findstr /?"'], { cwd: ws, env, encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true, timeout: 30_000 });
  assert.match(proof.stdout, /BARE108-PLANTED/, `precondition: without the variable a bare findstr runs the planted file\n${proof.stdout}${proof.stderr}`);

  const pipe = `\\\\.\\pipe\\bare108-${process.pid}-${Date.now()}`;
  let got = '';
  const server = net.createServer((s) => { s.setEncoding('utf8'); s.on('data', (d) => { got += d; }); });
  await new Promise((res, rej) => { server.once('error', rej); server.listen(pipe, res); });
  t.after(() => server.close());
  const cmdFile = path.join(bin, 'agy-oneway.cmd');
  fs.writeFileSync(cmdFile, agyOnewayCmd(pipe));

  const child = spawn(COMSPEC, ['/d', '/c', cmdFile, 'PostToolUse', 'agy'], { cwd: ws, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.stdin.end('{"body":"bare108-hello"}\r\n');
  const code = await new Promise((res) => child.on('close', res));
  for (let i = 0; i < 50 && !got.includes('bare108-hello') && !got.includes('BARE108-PLANTED'); i += 1) await new Promise((r) => setTimeout(r, 100));

  assert.equal(code, 0, out);
  assert.doesNotMatch(got, /BARE108-PLANTED/, `the workspace's findstr.bat ran; the pipe got: ${JSON.stringify(got)}`);
  assert.match(got, /^PostToolUse agy tok108 agent108/, `header line: ${JSON.stringify(got)}`);
  assert.match(got, /bare108-hello/, `the real findstr passed the body through: ${JSON.stringify(got)}`);
});
