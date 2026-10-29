'use strict';

// WAKEUP-WING-WRONG-SET-191: changing the claims provider back to the caller
// must make the caller-not-selected-wing regression fail.  Keep this explicit
// source mutant so a future refactor cannot silently disconnect the test.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { recover, mutateFile, restoreFile, checkAnchors } = require('./mutant-runner-helper.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const FILE = 'src/main/nativeMemory/mainWiring.ts';
const TEST = 'test/native-memory.test.cjs';
const FROM = 'this.claimWakeup?.(wing)';
const TO = 'this.claimWakeup?.(agentId)';

recover(ROOT);
if (process.argv.includes('--recover-only')) process.exit(0);

checkAnchors(ROOT, [{ name: 'wake-up claims use selected wing', file: FILE, from: FROM }]);
const run = () => spawnSync(process.execPath, ['--test', TEST], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
if (run().status !== 0) {
  console.log('BASELINE RED: the unmutated native-memory test fails, so this mutant proves nothing.');
  process.exit(2);
}

const abs = path.join(ROOT, FILE);
const original = fs.readFileSync(abs, 'utf8');
const crlf = original.includes('\r\n');
const source = original.replace(/\r\n/g, '\n');
const at = source.indexOf(FROM);
if (at < 0 || source.indexOf(FROM, at + 1) >= 0) {
  console.log(`INERT wake-up claims use selected wing (anchor ${at < 0 ? 'missing' : 'not unique'})`);
  process.exit(1);
}
let mutated = source.slice(0, at) + TO + source.slice(at + FROM.length);
if (crlf) mutated = mutated.replace(/\n/g, '\r\n');
try {
  mutateFile(ROOT, abs, original, mutated);
  const result = run();
  if (result.status !== 0) {
    console.log('KILLED wake-up claims use caller instead of selected wing');
  } else {
    console.log('SURVIVED wake-up claims use caller instead of selected wing');
  }
  process.exitCode = result.status !== 0 ? 0 : 1;
} finally {
  restoreFile(ROOT, abs, original);
}
