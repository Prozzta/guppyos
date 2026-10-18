#!/usr/bin/env node
'use strict';

// AGENT-ENV-NODEFAULTCWD-193: node-pty 1.1.0's deps/winpty/src/winpty.gyp runs two batch
// files by a BARE name ('cd shared && GetCommitHash.bat', and UpdateGenVersion.bat). A bare
// name resolves only through the current directory, and NoDefaultCurrentDirectoryInExePath
// (set by the Claude Code CLI for every tool shell, a binary-planting guard) turns that
// lookup off, so electron-rebuild failed in agent shells unless the variable was unset.
// A qualified `.\Name.bat` still resolves with the variable set, so the guard stays on.
//
// Strict like patch-node-pty-race-fix: by SHA-256 of winpty.gyp,
//   pristine 1.1.0 -> patch, then require the result to equal the pinned patched digest
//   already patched -> no-op (second npm ci / npm rebuild / npm run postinstall)
//   anything else  -> fail (different node-pty, partial patch, line-ending change, ...)
// `--check` only asserts the patched digest (the last postinstall step, so a patch that was
// skipped or undone fails loudly). `--root <node-pty dir>` targets another tree (self-test).
//
// gyp reads the file as Python literals: the backslash is written doubled, or
// '.\UpdateGenVersion.bat' would be a \U escape.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const NODE_PTY_VERSION = '1.1.0';
const WINPTY_GYP_PRISTINE_SHA256 = 'c67cd1b1d1e5aad4ac8795dccdb94df3bd43fd5f268cdeb7d4ce183bf6ce6315';
const WINPTY_GYP_PATCHED_SHA256 = 'f018de7f091a4e3ac76c0d20d11b1ce4c33160cf064c3c0cd93e749aabc6a812';
const CALLS = ['GetCommitHash.bat', 'UpdateGenVersion.bat'];

if (require.main !== module) {
  module.exports = { NODE_PTY_VERSION, WINPTY_GYP_PRISTINE_SHA256, WINPTY_GYP_PATCHED_SHA256, CALLS };
  return;
}
if (process.platform !== 'win32') process.exit(0);
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const root = arg('--root') ? path.resolve(arg('--root')) : path.join(__dirname, '..', 'node_modules', 'node-pty');
const check = process.argv.includes('--check');
const file = path.join(root, 'deps', 'winpty', 'src', 'winpty.gyp');
const fail = (msg) => { console.error(`[patch-node-pty-winpty-gyp] FAILED: ${msg}`); process.exit(1); };
const pkgPath = path.join(root, 'package.json');
if (!fs.existsSync(pkgPath)) fail(`node-pty package.json missing at ${pkgPath}`);
const version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
if (version !== NODE_PTY_VERSION) fail(`node-pty ${NODE_PTY_VERSION} required, got ${version}; re-check winpty.gyp's batch calls before changing the dependency`);
if (!fs.existsSync(file)) fail('node-pty deps/winpty/src/winpty.gyp missing');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
let source = fs.readFileSync(file, 'utf8');
const inputSha = sha(source);
if (inputSha === WINPTY_GYP_PATCHED_SHA256) {
  console.log(`[patch-node-pty-winpty-gyp] winpty.gyp batch calls ${check ? 'are' : 'already'} qualified`);
  process.exit(0);
}
if (check) fail(`winpty.gyp is not the pinned patched form (sha256 ${inputSha}): the batch calls would fail with NoDefaultCurrentDirectoryInExePath set`);
if (inputSha !== WINPTY_GYP_PRISTINE_SHA256) fail(`winpty.gyp is neither pristine 1.1.0 nor the pinned patched form (sha256 ${inputSha})`);
for (const bat of CALLS) {
  const before = `cd shared && ${bat}`;
  if (source.split(before).length !== 2) fail(`winpty.gyp patch point missing or repeated: ${bat}`);
  source = source.replace(before, `cd shared && .\\\\${bat}`);
}
const outSha = sha(source);
if (outSha !== WINPTY_GYP_PATCHED_SHA256) fail(`patched winpty.gyp sha256 ${outSha} != pinned ${WINPTY_GYP_PATCHED_SHA256}`);
fs.writeFileSync(file, source);
console.log('[patch-node-pty-winpty-gyp] winpty.gyp batch calls qualified (.\\GetCommitHash.bat, .\\UpdateGenVersion.bat)');
