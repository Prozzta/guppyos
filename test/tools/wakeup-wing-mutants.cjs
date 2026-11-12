'use strict';

// WAKEUP-WING-WRONG-SET-191: changing the claims provider back to the caller
// must make the caller-not-selected-wing regression fail.  Keep this explicit
// source mutant so a future refactor cannot silently disconnect the test.
const fs = require('node:fs');
const path = require('node:path');
const { recover, mutateFile, restoreFile, checkAnchors, runTests, verdict, requireBaseline } = require('./mutant-runner-helper.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const FILE = 'src/main/nativeMemory/mainWiring.ts';
const TEST = 'test/native-memory.test.cjs';
const FROM = 'this.claimWakeup?.(wing)';
const TO = 'this.claimWakeup?.(agentId)';

recover(ROOT);
if (process.argv.includes('--recover-only')) process.exit(0);

checkAnchors(ROOT, [{ name: 'wake-up claims use selected wing', file: FILE, from: FROM }]);
const run = () => runTests(ROOT, [TEST], { timeout: 300_000 });
requireBaseline(run(), 'the unmutated native-memory test');

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
  const v = verdict(result); // NO-RESULT (the run never reported) is loud: neither a kill nor a survivor
  console.log(`${v} wake-up claims use caller instead of selected wing${v === 'NO-RESULT' ? ` (${result.why})` : ''}`);
  process.exitCode = v === 'KILLED' ? 0 : 1;
} finally {
  restoreFile(ROOT, abs, original);
}
