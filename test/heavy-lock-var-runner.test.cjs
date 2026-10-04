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

  for (const cmd of [
    '$NODE test/tools/run-tests.cjs',
    '& $node test/tools/run-tests.cjs',
    '$env:CR node test/tools/run-tests.cjs',
    '${CR:-} node test/tools/run-tests.cjs',
    '$(which node) test/tools/run-tests.cjs',
    '`which node` test/tools/run-tests.cjs',
  ]) assert.equal(classifyCommand(cmd).kind, 'suite', cmd);
  assert.equal(classifyCommand('eval "$CMD"').heavy, false, 'eval policy is out of scope');
});

test('cmd /c bodies preserve heavy Node runners except the doubled-outer-quote shim form', () => {
  assert.equal(classifyCommand('cmd /s /c "C:\\Tools\\node.exe test/tools/run-tests.cjs"').kind, 'suite');
  assert.equal(classifyCommand('cmd /s /c "C:\\Program Files\\nodejs\\node.exe test/tools/run-tests.cjs"').kind, 'suite');
  assert.equal(classifyCommand('C:\\WINDOWS\\system32\\cmd.exe /d /s /c ""C:\\nvm\\v20\\npm.cmd" ci"').heavy, false);
});

test('attached redirects consume a quoted target with spaces as one word', () => {
  assert.equal(classifyCommand('node test/tools/run-tests.cjs *>"C:/invented path/full.log"').kind, 'suite');
  assert.equal(classifyCommand('node test/tools/run-tests.cjs >&"C:/invented path/full.log"').kind, 'suite');
  assert.equal(classifyCommand('node --test test/one.test.cjs 2>"C:/invented path/one.log"').heavy, false);
  assert.equal(classifyCommand('node "test/tools/run-tests.cjs">full.log').kind, 'suite');
  assert.equal(classifyCommand("node 'test/tools/run-tests.cjs'>full.log").kind, 'suite');
  assert.equal(classifyCommand('node "test/tools/run-tests.cjs').kind, 'suite', 'a malformed quote cannot hide a recognizable runner');
  assert.equal(classifyCommand('echo "don\'t"; node test/tools/run-tests.cjs').kind, 'suite', 'an apostrophe inside double quotes does not close them');
});

test('MUTANT CENSUS: attached redirects and dynamic Node runners fail closed', () => {
  const filename = require('node:path').resolve(__dirname, '..', 'src/main/heavyJob.ts');
  const source = require('node:fs').readFileSync(filename, 'utf8');
  const mutants = [
    {
      name: 'quoted script followed by attached redirect stays one word',
      from: "if (!q && w && redirectAt.test(s.slice(i)) && !redirectAt.test(w + s.slice(i))) break;",
      to: '// mutant: omitted attached redirect boundary',
      probe: (mutant) => assert.equal(mutant.classifyCommand('node "test/tools/run-tests.cjs">full.log').kind, 'suite'),
    },
    {
      name: 'dynamic Node command hides a heavy runner',
      from: "\n      return classifyWords(['node', ...ws.slice(1)], depth, ctx);",
      to: "\n      return { heavy: false }; // mutant: ignore dynamic runner arguments",
      probe: (mutant) => assert.equal(mutant.classifyCommand('$NODE test/tools/run-tests.cjs').kind, 'suite'),
    },
  ];
  for (const mutant of mutants) {
    const hits = source.split(mutant.from).length - 1;
    assert.equal(hits, 1, `mutant ${mutant.name} target must match exactly once`);
    const altered = source.replace(mutant.from, mutant.to);
    const loaded = loadTs.fromText(filename, altered);
    assert.throws(() => mutant.probe(loaded), assert.AssertionError, `SURVIVED: ${mutant.name}`);
  }
});
