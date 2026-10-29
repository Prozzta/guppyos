'use strict';
require('./tools/own-job.cjs');
/**
 * CLAIMS-90 labeller jail (test-only tooling). Pins the guard's rules, the jail's forbidden-name
 * check, the transcript audit (compaction, out-of-jail calls) and the key-file check.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const G = require('./claims-90/labeller-guard.cjs');
const L = require('./claims-90/labeller.cjs');

const jail = path.join(os.tmpdir(), 'c90-jail-test');
const keyFile = path.join(jail, 'key.jsonl');
const ck = (tool, input) => G.check(tool, input, jail, keyFile);

test('guard: reads, searches and the one write stay in the jail', () => {
  assert.equal(ck('Read', { file_path: path.join(jail, 'hive', 'tasks.json') }).decision, 'allow');
  assert.equal(ck('Read', { file_path: 'hive/board.md' }).decision, 'allow', 'relative to the jail');
  for (const p of ['C:/Dunder/hive/agents/x/memory.md', '/c/Dunder/hive/tasks.json', path.join(jail, '..', 'other'), 'hive/../../x']) {
    const v = ck('Read', { file_path: p });
    assert.deepEqual([v.decision, v.place], ['deny', 'outside'], p);
  }
  assert.equal(ck('Read', { file_path: path.join(G.ownOutputsDir(jail), 's', 'tool-results', 'x.txt') }).place, 'own-output', 'its own saved outputs');
  assert.equal(ck('Read', { file_path: path.join(os.homedir(), '.claude', 'projects', 'C--Dunder-hive-agents-x', 'tool-results', 'y.txt') }).place, 'outside', 'another project\'s saved outputs');
  assert.equal(ck('Grep', { pattern: 'x', path: 'hive' }).decision, 'allow');
  assert.equal(ck('Grep', { pattern: 'x' }).decision, 'allow', 'no path = the jail');
  assert.equal(ck('Grep', { pattern: 'x', path: 'C:/Dunder/_work' }).place, 'outside');
  assert.equal(ck('Glob', { pattern: 'C:/Dunder/hive/**/memory.md' }).place, 'outside');
  assert.equal(ck('Glob', { pattern: '../**' }).place, 'outside');
  assert.equal(ck('Glob', { pattern: 'hive/**/*.json' }).decision, 'allow');
  assert.equal(ck('Write', { file_path: keyFile }).decision, 'allow');
  assert.equal(ck('Write', { file_path: path.join(jail, 'hive', 'tasks.json') }).decision, 'deny', 'only the key file');
  assert.equal(ck('Write', { file_path: 'C:/Dunder/x.jsonl' }).place, 'outside');
  assert.equal(ck('Edit', { file_path: keyFile }).decision, 'deny', 'tools outside the set');
});

test('guard: Bash runs one read-only git command', () => {
  for (const c of ['git log --oneline -20', 'git show v1.1.101:CHANGELOG.md', 'git log --grep "a|b; c" --all', 'git tag --contains abc123', 'git log a..b']) assert.equal(ck('Bash', { command: c }).decision, 'allow', c);
  for (const c of ['cat hive/tasks.json', 'git log | head', 'git log; ls', 'git log > x', 'git config alias.x "!cat"', 'git -c core.pager=cat log', 'git -C /c/Dunder/_work/guppyos-repo log', 'git --git-dir=/c/x log', 'git diff --no-index a b', 'git log --output=x', 'git grep -O x', 'echo $(git log)']) assert.equal(ck('Bash', { command: c }).decision, 'deny', c);
  assert.equal(ck('Bash', { command: 'git show HEAD:x /c/Dunder/hive/x' }).place, 'outside', 'a path word outside the jail');
});

test('guard hook: denies in the PreToolUse shape and writes the open log', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c90-guard-'));
  const log = path.join(dir, 'open.jsonl');
  const run = (payload) => spawnSync(process.execPath, [path.join(__dirname, 'claims-90', 'labeller-guard.cjs'), jail, log, keyFile], { input: JSON.stringify(payload), encoding: 'utf8' });
  const deny = run({ tool_name: 'Read', tool_use_id: 't1', tool_input: { file_path: 'C:/Dunder/hive/tasks.json' } });
  assert.equal(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const allow = run({ tool_name: 'Read', tool_use_id: 't2', tool_input: { file_path: 'hive/tasks.json' } });
  assert.equal(allow.stdout, '');
  const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map((r) => [r.toolUseId, r.place, r.decision]), [['t1', 'outside', 'deny'], ['t2', 'jail', 'allow']]);
});

test('jail: forbidden names are caught; the docs are not', () => {
  const f = (p) => ({ path: p });
  assert.deepEqual(L.forbiddenIn(['docs/CLAIMS-90-SPEC-v2-excerpt.md', 'docs/LABEL-GUIDE.md', 'docs/INSTRUCTIONS-H1.md','docs/LABEL-GUIDE-C90-v2.md', 'docs/batch-07.jsonl', 'docs/xcheck-andy-D.json', 'docs/INSTRUCTIONS.md', 'hive/tasks.json', 'hive/agents/a/inbox/.done/2026-x.json', 'repo.git/packed-refs'].map(f)), []);
  assert.deepEqual(L.parseArgs(['--snapshot', 's', '--addendum', 'a', '--labeller', 'andy', '--group', 'F', '--xcheck', 'x', '--batch', 'b', '--instructions', 'i', '--guide', 'g', '--pilot', 'p', '--prompt', 'q', '--key', 'k', '--out', 'o', '--claude', 'c', '--doc', 'C:/x/LABEL-GUIDE-base.md=LABEL-GUIDE.md']).docs, [{ from: 'C:/x/LABEL-GUIDE-base.md', name: 'LABEL-GUIDE.md' }]);
  for (const p of ['docs/CLAIMS-90-SPEC.md', 'hive/agents/a/memory/claims.jsonl','hive/agents/a/memory.md', 'hive/claims-reconcile-queue.json', 'docs/key-andy-h1.jsonl', 'sealed-jim/x', 'elig-f/out.json', 'x/index-v2.sqlite']) assert.equal(L.forbiddenIn([f(p)]).length, 1, p);
});

test('settings: the key file is allowed by an Edit rule (Claude Code judges Write by Edit rules); only the guard hook', () => {
  const s = L.settingsFor(jail, path.join(jail, '..', 'open.jsonl'), keyFile);
  const k = keyFile.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, x) => x.toLowerCase());
  assert.ok(s.permissions.allow.includes(`Edit(//${k})`));
  assert.ok(!s.permissions.deny.includes('Edit'), 'an Edit deny also blocks the one Write (measured in the plumbing run)');
  assert.deepEqual(Object.keys(s.hooks), ['PreToolUse'], 'no SessionStart, compaction or mail hook');
  assert.match(s.hooks.PreToolUse[0].hooks[0].command, /labeller-guard\.cjs/);
});

test('audit: a compaction or an out-of-jail call is caught; the key is judged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c90-audit-'));
  const t = path.join(dir, 't.jsonl');
  const use = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  fs.writeFileSync(t, [{ type: 'system', subtype: 'init', tools: L.TOOLS, plugins: [] }, use('a', 'Read', { file_path: 'hive/tasks.json' }), use('b', 'Read', { file_path: 'C:/Dunder/hive/agents/x/memory.md' }), { type: 'system', subtype: 'compact_boundary' }, { type: 'result', is_error: false, usage: { input_tokens: 1 } }].map((r) => JSON.stringify(r)).join('\n'));
  const a = L.auditTranscript(t, jail, keyFile);
  assert.deepEqual([a.calls.length, a.outside, a.compact], [2, 1, 1]);
  const own = L.ownRows([{ itemId: 'A', group: 'F' }, { itemId: 'B', group: 'D' }, { itemId: 'C', group: 'D' }], 'F', ['C']);
  assert.deepEqual(own.map((r) => r.itemId), ['A', 'C'], 'own group plus the cross-check ids');
  const k = L.checkKey('{"itemId":"A"}\n{"itemId":"B"}\n{"itemId":"A"}\nnot json\n', own);
  assert.deepEqual([k.keyed, k.missing, k.problems.length], [1, ['C'], 3]);
});
