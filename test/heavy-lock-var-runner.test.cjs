const assert = require('node:assert/strict');
const { test } = require('node:test');
const loadTs = require('./load-ts.cjs');
const { classifyCommand } = loadTs('src/main/heavyJob.ts');

test('a variable command word delegates classification to a nameable command', () => {
  for (const cmd of [
    '$CR node test/tools/run-tests.cjs',
    '"$CR" node test/tools/run-tests.cjs',
    '${CR} node test/tools/run-tests.cjs',
    '$CR npm test',
  ]) assert.equal(classifyCommand(cmd).kind, 'suite', cmd);

  assert.equal(classifyCommand('$NODE run-tests.cjs').heavy, false, 'a variable plus a script name is not a nameable command');
  assert.equal(classifyCommand('eval "$CMD"').heavy, false, 'eval policy is out of scope');
});

test('attached redirects consume a quoted target with spaces as one word', () => {
  assert.equal(classifyCommand('node test/tools/run-tests.cjs *>"C:/invented path/full.log"').kind, 'suite');
  assert.equal(classifyCommand('node test/tools/run-tests.cjs >&"C:/invented path/full.log"').kind, 'suite');
  assert.equal(classifyCommand('node --test test/one.test.cjs 2>"C:/invented path/one.log"').heavy, false);
});
