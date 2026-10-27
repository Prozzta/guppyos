'use strict';
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

test('guard: a quoted argument stays one word, escaped quotes and mid-token quotes included (H1 batch 06 false positive)', () => {
  // The two batch-06 calls: words() split -S"\"version\": \"1.1.85\"" at the quoted space and read
  // \"1.1.85\"" as a root-relative path, so a denied read made the batch INVALID.
  const batch06 = [
    'git log --oneline --format="%h %H %cI %s" -S"\\"version\\": \\"1.1.85\\"" origin/release-1.1.85 -- package.json',
    'git log --all --format="%H %cI %D %s" -G"\\"version\\": \\"1.1.85\\"" -- package.json',
  ];
  for (const c of batch06) assert.deepEqual([ck('Bash', { command: c }).decision, ck('Bash', { command: c }).place], ['allow', 'jail'], c);
  assert.deepEqual(G.words(batch06[0]), ['git', 'log', '--oneline', '--format=%h %H %cI %s', '-S"version": "1.1.85"', 'origin/release-1.1.85', '--', 'package.json']);
  assert.deepEqual(G.words('a "b c"d e\'f g\'h "x\\\\y"'), ['a', 'b cd', 'ef gh', 'x\\y'], 'adjacent pieces join; \\\\ in double quotes is one backslash');
  assert.deepEqual(G.words(' "" x '), ['', 'x'], 'an empty quoted word is a word');
  assert.equal(ck('Bash', { command: 'git log -S \\"1.1.85\\"' }).place, 'jail', 'a word starting with \\" is never a path word');
  // A real path outside stays outside, however it is quoted.
  for (const c of ['git log -- "C:/x"', 'git log -- \\x', 'git log -- C:"/x"', 'git log -- "\\\\server\\share"', 'git log -- \'/c/Dunder/hive\'', 'git log -- "a/../../x"']) {
    const v = ck('Bash', { command: c });
    assert.deepEqual([v.decision, v.place], ['deny', 'outside'], c);
  }
});

test('guard: one tokenizer finds chains and substitutions; -O, -f, ~, HOME, every path word and ref writes are judged (Jim, guard round 2)', () => {
  const is = (c, d, p) => { const v = ck('Bash', { command: c }); assert.deepEqual([v.decision, v.place], [d, p], c); };
  // MUST 1: an escaped quote outside quotes is a literal, so the ; runs a second command.
  for (const c of ['git log \\" ; echo x ; \\" "x"', 'git log "a" ; echo x', "git log 'a' ; echo x", 'git log a\\;b', 'git log\necho x', 'git log "$(echo x)"', 'git log "`echo x`"']) is(c, 'deny', 'jail');
  for (const c of ['git log --grep "a|b; c" --all', "git log --grep '$(x)'"]) is(c, 'allow', 'jail');
  assert.deepEqual(G.scan('git log \\" ; echo x').ops, [';']);
  // MUST 2: grep's pager in every form (stuck, bundled, =, separate, abbreviated); -f likewise.
  for (const c of ['git grep -Oless foo', 'git grep -iOless foo', 'git grep --open-files-in-pager=less foo', 'git grep -O less foo', 'git grep --open=less foo', 'git grep -fpats foo']) is(c, 'deny', 'jail');
  for (const c of ['git log -SOllama', 'git grep -e Oless', 'git grep --text foo']) is(c, 'allow', 'jail');
  // SHOULD a: the shell expands ~ and HOME outside the jail; other variables are denied.
  for (const c of ['git log -- ~/x', 'git log -- $HOME/x', 'git log -- ${HOME}/x', 'git log -- "$HOME/x"']) is(c, 'deny', 'outside');
  is('git log -- $PWD/x', 'deny', 'jail');
  // SHOULD b: every path word is judged, not only the first.
  const J = jail.replace(/\\/g, '/');
  is(`git show HEAD:a ${J}/a C:/Dunder/hive/x`, 'deny', 'outside');
  is(`git show HEAD:a ${J}/a`, 'allow', 'jail');
  // SHOULD c: git tag and git branch list; a form that writes a ref is denied.
  for (const c of ['git tag', 'git tag -l "v1.*"', 'git tag --list v1', 'git tag -n5 --points-at HEAD', 'git branch', 'git branch -a --contains abc', 'git branch -vv', 'git branch --list "rel*"']) is(c, 'allow', 'jail');
  for (const c of ['git tag newtag', 'git tag -a v9 -m x', 'git tag -d v1', 'git tag -l --del v1', 'git branch x', 'git branch -D x', 'git branch -m a b', 'git branch --set-upstream-to=o/x']) is(c, 'deny', 'jail');
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

test('god 3ba8b6 R5: the jail session folder is copied byte-equal into the run dir and deleted; another labeller is not judged', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'c90-label-r5-'));
  try {
    const projects = path.join(base, 'projects');
    const out = path.join(base, 'h1-runs', 'andy');
    const j = path.join(out, 'jail-batch-07-andy-AAA');
    const mine = path.join(projects, G.projectSlug(j));
    fs.mkdirSync(path.join(mine, 's1', 'tool-results'), { recursive: true });
    fs.writeFileSync(path.join(mine, 's1', 'tool-results', 'b1.txt'), 'spilled git output');
    const sele = path.join(projects, `${G.projectSlug(path.join(base, 'h1-runs', 'sele'))}-jail-batch-09-sele-BBB`);
    fs.mkdirSync(sele, { recursive: true });
    const dest = path.join(out, 'batch-07-andy', 'session');
    const r = L.sessionOut(projects, j, dest, out);
    assert.deepEqual(r, { session: { folder: G.projectSlug(j), created: true, files: 1, removed: true, problem: null }, leftovers: [], problem: null });
    assert.equal(fs.existsSync(mine), false, 'deleted from projects');
    assert.equal(fs.readFileSync(path.join(dest, G.projectSlug(j), 's1', 'tool-results', 'b1.txt'), 'utf8'), 'spilled git output');
    assert.ok(fs.existsSync(sele), 'another labeller\'s live session folder is untouched and not a leftover');
    // A folder of this --out's jails left behind is a leftover.
    const old = path.join(projects, `${L.leftoverPrefix(out)}batch-06-andy-OLD`);
    fs.mkdirSync(old, { recursive: true });
    const r2 = L.sessionOut(projects, path.join(out, 'jail-batch-08-andy-CCC'), dest, out);
    assert.equal(r2.session.created, false);
    assert.deepEqual(r2.leftovers, [path.basename(old)]);
    assert.match(r2.problem, /1 jail folder\(s\) left/);
    // A folder holding a link is never copied or deleted.
    const k = path.join(out, 'jail-batch-09-andy-DDD');
    const linked = path.join(projects, G.projectSlug(k));
    const target = path.join(base, 'target');
    fs.mkdirSync(linked, { recursive: true }); fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(path.join(target, 'keep.txt'), 'x');
    fs.symlinkSync(target, path.join(linked, 'link'), 'junction');
    assert.equal(L.sessionOut(projects, k, dest, out).session.problem, 'the session folder holds a link');
    assert.ok(fs.existsSync(path.join(target, 'keep.txt')) && fs.existsSync(linked));
    fs.unlinkSync(path.join(linked, 'link'));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('god 3ba8b6 R5 static: the session folder is moved out before the verdict and a problem is INVALID first', () => {
  const src = fs.readFileSync(path.join(__dirname, 'claims-90', 'labeller.cjs'), 'utf8');
  assert.match(src, /\n    const s = sessionOut\(path\.dirname\(G\.ownOutputsDir\(jail\)\), jail, path\.join\(runDir, 'session'\), o\.out\);\r?\n/);
  assert.match(src, /\n    if \(s\.problem\) reason = `session folder: /);
  assert.ok(src.indexOf('const s = sessionOut(') < src.indexOf('fs.appendFileSync(keyOut, lines)'), 'before any key row is appended');
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

test('LABELLER-GUARD-FALSEPOS (a): an unquoted operator ends a word, so a jail path before ; is the jail; outside paths, .., quoted ; and every deny stay', () => {
  const J = jail.replace(/\\/g, '/');
  const is = (c, d, p, why) => { const v = ck('Bash', { command: c }); assert.deepEqual([v.decision, v.place], [d, p], why || c); };
  // The A12b false void: `cd <jail>; cat ...` read "<jail>;" as a sibling folder outside the jail. Denied still (not one git command), but in the jail.
  is(`cd ${J}; cat docs/x.json; ls hive`, 'deny', 'jail', 'the jail path before ; is the jail');
  is(`cd ${J}&& ls hive`, 'deny', 'jail');
  is(`cd ${J}|cat`, 'deny', 'jail');
  is(`cat ${J}/docs/x.json>out`, 'deny', 'jail');
  assert.deepEqual(G.words(`cd ${J}; ls hive`), ['cd', J, 'ls', 'hive'], 'the operator is no word');
  assert.deepEqual(G.scan(`cd ${J}; ls hive`).ops, [';']);
  assert.deepEqual(G.words('a&&b||c|d;e>f<g 2>&1'), ['a', 'b', 'c', 'd', 'e', 'f', 'g', '2', '1']);
  // Negatives: nothing loosens.
  is('cd C:/Dunder/hive; ls', 'deny', 'outside', 'an outside path before ; is outside');
  is(`cat ${J}/../x;`, 'deny', 'outside', '.. before ; is outside');
  is(`${J};../x`, 'deny', 'outside', '.. after ; is outside');
  is(`cd ${J};C:/Dunder/hive/x`, 'deny', 'outside', 'a ;-joined outside path is judged on its own');
  is(`cd ${J}; cat C:/Dunder/hive/tasks.json`, 'deny', 'outside', 'a real outside path after a jail cd');
  is('cat C:/Dunder/hive/tasks.json;', 'deny', 'outside', 'an outside path with a trailing ;');
  is('echo x>C:/Dunder/hive/out', 'deny', 'outside', 'a redirection target outside the jail is a path word now');
  is('echo x;/etc/passwd', 'deny', 'outside');
  is('git log -- ~/x; ls', 'deny', 'outside');
  is('git log -- $HOME/x; ls', 'deny', 'outside');
  // Quoted and escaped operators stay in the word; an escaped operator is still an op (denied as a chain).
  assert.deepEqual(G.words("git log --grep 'a;b' \"c|d\""), ['git', 'log', '--grep', 'a;b', 'c|d']);
  is("git log --grep 'a;b' \"c|d\" --all", 'allow', 'jail', 'quoted operators are literal');
  assert.deepEqual(G.words('git log a\\;b'), ['git', 'log', 'a\\;b'], 'an escaped ; stays in the word');
  is('git log a\\;b', 'deny', 'jail', 'an escaped ; is still an op');
  for (const c of ['git log \\" ; echo x ; \\" "x"', 'git log "a" ; echo x', 'git log\necho x', 'git log "$(echo x)"', 'git log "`echo x`"', 'git log | cat', 'git log > x']) is(c, 'deny', 'jail');
  assert.deepEqual(G.words('git log \\" ; echo x'), ['git', 'log', '\\"', 'echo', 'x']);
});

test('LABELLER-GUARD-FALSEPOS (b): a call the CLI rejected at input validation is not unlogged; any other call missing from the open log still voids', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c90-audit-fp-'));
  const t = path.join(dir, 't.jsonl');
  const use = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  const res = (id, content, is_error) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(is_error ? { is_error: true } : {}) }] } });
  const VAL = '<tool_use_error>InputValidationError: Glob failed due to the following issue:\nAn unexpected parameter `head_limit` was provided</tool_use_error>';
  fs.writeFileSync(t, [
    { type: 'system', subtype: 'init', tools: L.TOOLS, plugins: [] },
    use('ok', 'Read', { file_path: 'hive/tasks.json' }), res('ok', 'file text'),
    use('rej', 'Glob', { pattern: 'hive/**', head_limit: 5 }), res('rej', VAL, true),
    use('rej2', 'Grep', { pattern: 'x', path: 'hive' }), res('rej2', [{ type: 'text', text: VAL }], true),
    use('err', 'Bash', { command: 'git log' }), res('err', 'exit code 128', true),
    use('den', 'Read', { file_path: 'C:/Dunder/hive/agents/x/memory.md' }), res('den', VAL, true),
    use('noerr', 'Read', { file_path: 'hive/a.md' }), res('noerr', VAL),
    use('none', 'Read', { file_path: 'hive/b.md' }),
    { type: 'result', num_turns: 3 },
  ].map((r) => JSON.stringify(r)).join('\n'));
  const a = L.auditTranscript(t, jail, keyFile);
  assert.deepEqual(a.calls.map((c) => [c.id, c.rejected]), [['ok', false], ['rej', true], ['rej2', true], ['err', false], ['den', true], ['noerr', false], ['none', false]], 'only the InputValidationError result (string or text parts, is_error) marks a call rejected');
  assert.equal(a.rejected, 3);
  assert.equal(a.outside, 1, 'a rejected call naming an outside path still counts as outside');
  const logged = (...ids) => ids.map((id) => ({ toolUseId: id }));
  assert.deepEqual(L.unloggedCalls(a.calls, logged('ok', 'err', 'noerr', 'none')).map((c) => c.id), [], 'a validation-rejected call needs no open-log row');
  assert.deepEqual(L.unloggedCalls(a.calls, logged('ok', 'noerr', 'none')).map((c) => c.id), ['err'], 'an unlogged call with an ordinary error result still voids');
  assert.deepEqual(L.unloggedCalls(a.calls, logged('ok', 'err', 'none')).map((c) => c.id), ['noerr'], 'the validation text without is_error does not exempt');
  assert.deepEqual(L.unloggedCalls(a.calls, logged('err', 'noerr', 'none')).map((c) => c.id), ['ok'], 'an unlogged call with a normal result still voids');
  assert.deepEqual(L.unloggedCalls(a.calls, []).map((c) => c.id), ['ok', 'err', 'noerr', 'none']);
  assert.equal(L.isValidationRejection('  <tool_use_error>InputValidationError: x'), true);
  for (const c of ['InputValidationError: x', '<tool_use_error>Error: x</tool_use_error>', 'x <tool_use_error>InputValidationError', '', null, [{ type: 'image' }]]) assert.equal(L.isValidationRejection(c), false, JSON.stringify(c));
  // The verdict uses the helper (the batch run itself needs a live claude).
  const src = fs.readFileSync(path.join(__dirname, 'claims-90', 'labeller.cjs'), 'utf8');
  assert.match(src, /\n    const unlogged = unloggedCalls\(a\.calls, log\)\.length;\r?\n/);
  assert.match(src, /else if \(unlogged\) reason = `\$\{unlogged\} call\(s\) missing from the open log`;/);
});
