'use strict';
require('./tools/own-job.cjs');
// MUTANT-JOURNAL-GATE (god 5cc045/ed8032): this suite loads a file a census mutates in place (one load-ts never sees);
// refuse a tree a killed census left mutated, before anything is read.
require('./tools/mutant-runner-helper.cjs').gate(__filename);
/**
 * CLAIMS-90 Phase 3 pins for the scoring runner (test/claims-90/): the snapshot check, the items
 * check, the containment checks, and the real-CLI shim passing argv through unchanged (spec 1b, 7).
 * The live answer run itself needs the frozen snapshot and the MAC key, so it is not run here.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { readSource, codeOnly } = require('./read-source.cjs');
const { parseItems, verifySnapshot, verifyAddendum, parseArgs } = require('./claims-90/run.cjs');
const { valueAt } = require('./claims-90/addendum.cjs');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function tmpSnapshot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c90-snap-'));
  fs.mkdirSync(path.join(dir, 'hive'));
  fs.writeFileSync(path.join(dir, 'hive', 'a.jsonl'), 'one\n');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ hiveRoot: 'X:/hive', files: [{ path: 'hive/a.jsonl', group: 'retrieval', sha256: sha('one\n') }] }));
  return dir;
}

test('the snapshot check passes an intact copy and names a changed or missing file', () => {
  const dir = tmpSnapshot();
  assert.deepEqual(verifySnapshot(dir).diffs, []);
  fs.writeFileSync(path.join(dir, 'hive', 'a.jsonl'), 'two\n');
  assert.deepEqual(verifySnapshot(dir).diffs, ['changed hive/a.jsonl']);
  fs.rmSync(path.join(dir, 'hive', 'a.jsonl'));
  assert.deepEqual(verifySnapshot(dir).diffs, ['missing hive/a.jsonl']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('items: unique ids, an agent-id asker, at most 3 searches, each an argv list of strings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c90-items-'));
  const f = path.join(dir, 'items.jsonl');
  const bad = (rows, re) => { fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n')); assert.throws(() => parseItems(f), re); };
  fs.writeFileSync(f, `${JSON.stringify({ id: 'a', asker: 'creed-mukyiphw', searches: [['search', '--results', '3', 'x y']] })}\r\n\r\n`);
  assert.deepEqual(parseItems(f)[0].searches, [['search', '--results', '3', 'x y']], 'argv kept exactly as written');
  bad([{ id: 'a', asker: 'x', searches: [] }, { id: 'a', asker: 'x', searches: [] }], /repeated/);
  bad([{ id: 'a', asker: 'C:/Dunder/hive', searches: [] }], /bad asker/);
  bad([{ id: 'a', asker: 'x', searches: [['search', 'a'], ['search', 'b'], ['search', 'c'], ['search', 'd']] }], /at most 3/);
  bad([{ id: 'a', asker: 'x', searches: ['search q'] }], /argv list/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('arguments: snapshot, addendum, items and out are required; nothing unknown is accepted', () => {
  assert.throws(() => parseArgs(['--items', 'i', '--out', 'o']), /--snapshot is required/);
  assert.throws(() => parseArgs(['--snapshot', 's', '--items', 'i', '--out', 'o']), /--addendum is required/);
  assert.throws(() => parseArgs(['--snapshot', 's', '--addendum', 'a', '--items', 'i', '--out', 'o', '--live']), /unknown argument --live/);
});

test('PIN: the shim runs the tree\'s real memory CLI with the item\'s argv unchanged, as an agent shell would', () => {
  const child = codeOnly(readSource('test/claims-90/answer-child.cjs'));
  assert.match(child, /const cli = path\.join\(spec\.tree, 'resources', 'memory-cli\.cjs'\);/, 'the tree\'s own CLI');
  assert.match(child, /spawn\(process\.execPath, \[cli, \.\.\.cliArgv\]/, 'argv passed through, nothing added or dropped');
  assert.match(child, /const full = argv\[argv\.length - 1\] === '#full';\n\s*const cliArgv = full \? argv\.slice\(0, -1\) : argv;/, 'M1: a trailing #full is the shell comment: never sent to the CLI');
  assert.match(child, /\.join\(' '\) \+ \(full \? ' #full' : ''\);/, 'M1: ...but it is in the command the condenser checks');
  assert.match(child, /MUNDER_HIVE_ROOT: hive, MUNDER_MEMORY_URL: baseUrl, MEMORY_TOKEN: nativeMemory\.tokens\.mint\(asker\)/, 'the env main injects, pointing at the sandbox');
  assert.match(child, /nativeMemory\.handle\(m\[1\], body\)/, 'the route hands the body to main\'s own handler');
  assert.match(child, /nativeMemory\.setClaimWakeupProvider\(\(agentId\) => claimDelivery\.workingSet\(agentId\)\)/, 'wake-up gets main\'s claims append');
  assert.match(child, /claimDelivery\.workingSet\(item\.asker, s, WORKING_SET_MAX_CHARS\)/, 'the briefing entry\'s ceiling');
  assert.match(child, /onWorkerReady: \(\) => \{ workerReady = claimsIndex\.syncAll\(\); \}/, 'main\'s re-sync on worker start');
});

test('PIN: containment before product code, and no answer over a ledger that does not fully verify', () => {
  const child = codeOnly(readSource('test/claims-90/answer-child.cjs'));
  const jailAt = child.indexOf('const jail = jailProblem();');
  assert.ok(jailAt > 0 && jailAt < child.indexOf("L('src/main/claims/store.ts')"), 'the jail check runs before any tree module loads');
  assert.match(child, /LIVE_HIVE_RE\.test\(p\) \|\| !under\(p, spec\.home\)/, 'hive and user data must be inside the jailed home');
  assert.match(child, /const LEAK_RE = \/\^\(HIVE_\|AGENT_\|MEMORY_\|MUNDER_\|CLAUDE_CODE_\|CLAUDE\|CTH_\|KG_\)\/i;/);
  assert.match(child, /filter\(\(\[, v\]\) => v\.verified !== v\.records\)/, 'every ledger verifies to its full length');
  // Jim 4370f6 / god 8c87a7: get and history answer through main's read wiring; writes stay refused (level reader).
  assert.match(child, /\n\s+claims: \(\) => claimsDeps,\r?\n/, 'the read verbs are wired for the answerer');
  assert.doesNotMatch(child, /claims: \(\) => null/, 'no path serves the answerer without claims deps');
  const run = codeOnly(readSource('test/claims-90/run.cjs'));
  assert.match(run, /if \(links\.length\) throw/, 'a link or junction in the snapshot stops the run');
  assert.match(run, /if \(v\.diffs\.length\) throw/, 'a manifest difference stops the run');
  assert.match(run, /fs\.copyFileSync\(path\.join\(snap, f\.path\), dest\)/, 'the snapshot is copied, never used in place');
  const key = codeOnly(readSource('test/claims-90/key-unwrap.cjs'));
  assert.match(key, /new SafeStorageKeyProvider\(path\.join\(userData, MAC_KEY_FILE\), safeStorage\)\.load\(\)/, 'the product\'s own key provider');
  assert.doesNotMatch(key + run, /writeFileSync\([^)]*key\b/, 'the key is never written to a file');
});

test('PIN: what the asker reads is what hooks.ts condensedToolOutput gives it (Jim M2, m2; identity check)', () => {
  const child = codeOnly(readSource('test/claims-90/answer-child.cjs'));
  assert.match(child, /const r = \{ stdout: stdout\.trim\(\), stderr: stderr\.trim\(\), interrupted: false \};/, 'the Bash tool hands the hook trimmed output');
  assert.match(child, /if \(provider && provider !== 'claude'\) return \{ provider, cap: 0, seen: seenRaw, condensed: null \};/, 'only a claude agent is condensed');
  assert.match(child, /const isGod = typeof own !== 'number' && \(reg\.godId === asker \|\| !!meta\.isGod\);/, 'god as hive.isGod, unless the registry sets a cap');
  assert.match(child, /C\.capForCommand\(command, isGod && configured \? Math\.max\(configured, C\.TOOL_OUTPUT_CAP_READ\) : configured\)/, 'god gets at least the read cap');
  assert.match(child, /const dir = path\.join\(hive, 'agents', asker, 'tool-output'\);/, 'the full text is saved where the agent can Read it');
  assert.match(child, /C\.condenseOutput\(\{ text: seenRaw, cap, path: saved \}\)/, 'the footer names that real file');
  assert.match(child, /for \(const s of item\.briefing === false \? \[\] : sources\)/, 'briefing: false answers the wake-up as a mid-session call (a render leases reconcile prompts)');
});

test('PIN: the world view answers from the addendum, never the live disk (Jim M3)', () => {
  const child = codeOnly(readSource('test/claims-90/answer-child.cjs'));
  assert.match(child, /git: frozenGit,\n\s*fileExists: frozenFileExists,/, 'delivery gets the frozen callbacks');
  assert.match(child, /if \(world\.cwds\?\.\[cwd\]\?\.git !== 'not-a-repository'\) worldCalls\.unrecorded\.push/, 'git is only answered for a cwd recorded as no repository');
  assert.match(child, /if \(worldCalls\.unrecorded\.length\) return \{ ok: false,/, 'an unrecorded world question fails the run');
  assert.match(child, /if \(persistRisk\.length\) return \{ ok: false,/, 'S2: an output Claude Code would save itself fails the run');
  assert.equal((child.match(/summary: \{ \.\.\.verdict\(\),/g) || []).length, 2, 'both modes report the verdict');
  const run = codeOnly(readSource('test/claims-90/run.cjs'));
  assert.match(run, /const now = o\.now \|\| v\.manifest\.takenFrom;/, 'm1: now defaults to T_s (takenFrom)');
  assert.match(run, /index\.afterResync = sha256\(fs\.readFileSync\(indexFile\)\);/, 'm3: the index sha after the re-sync');
});

test('PIN: the contained answerer reads what the tree\'s own hook gives it (M4, Jim S1, S2, NIT)', () => {
  const child = codeOnly(readSource('test/claims-90/answer-child.cjs'));
  assert.match(child, /updatedToolOutput = hooks\.condensedToolOutput\(asker, \{ \.\.\.p, transport: 'http' \}\)/, 'the tree\'s HookServer decides and condenses');
  assert.match(child, /return updatedToolOutput \? \{ hookSpecificOutput: \{ hookEventName: 'PostToolUse', updatedToolOutput \} \} : \{\};/, 'the reply shape hooks.ts sends');
  assert.match(child, /const v = viewOf\(asker, command, 0, r\.stdout,[^\n]*p\.tool_use_id\);\n\s*row\.runner = v\.condensed;\n\s*row\.parity = row\.hook === row\.runner;/, 'gate 1: the runner\'s view of the same output beside it');
  assert.match(child, /if \(n > spec\.serve\.maxCalls\) \{/, 'spec 1b: at most 5 tool calls');
  assert.match(child, /if \(code !== 0\) return \{ provider: provider \?\? null, cap, seen: `Exit code \$\{code\}\\n\$\{seenRaw\}`, condensed: null \};/, 'S1: a failed call is read raw, after Claude Code\'s exit line');
  assert.match(child, /if \(seenRaw\.length >= CLAUDE_CODE_PERSIST_CHARS\) persistRisk\.push\(command\);/, 'S2');
  assert.match(child, /filter\(\(a\) => !normalizeAgentProvider\(reg\.agents\?\.\[a\]\?\.provider\)\)/, 'NIT: every asker names a provider');
  const ans = codeOnly(readSource('test/claims-90/answerer.cjs'));
  assert.match(ans, /'--setting-sources', 'project,local', '--strict-mcp-config', '--disable-slash-commands',/, 'no user settings, MCP servers, skills or commands');
  assert.match(ans, /'--tools', 'Bash,Read'/, 'only the shim tools');
  assert.match(ans, /allow: \['Bash\(memory:\*\)', `Read\(/, 'Bash only for memory, Read only on its saved outputs');
  assert.match(ans, /if \(t\.leaks\.length\) row\.invalid = /, 'a leak makes the item INVALID');
  assert.match(ans, /const row = await answerItem\(/, 'one fresh sandbox and session per item');
  assert.match(ans, /readType: c\.tool === 'Bash' && c\.command \? Condense\.isReadCommand\(c\.command\) : null,/, 'god ruling 1: read-type or bare, per call, by the product\'s own test');
  assert.match(ans, /R\.stageSandbox\(path\.resolve\(o\.snapshot\), v\.manifest, home\)/, 'each item starts from the T_s copy');
});

test('answerer: hook settings follow the installed shape; env and transcript checks', () => {
  const { settingsFor, childEnv, readTranscript, styleDeviation, parseItems: answererItems } = require('./claims-90/answerer.cjs');
  const itemsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'c90-ai-')), 'items.jsonl');
  fs.writeFileSync(itemsFile, [{ itemId: 'DV001', asker: 'god', question: 'q?', group: 'F' }, { id: 'P1', asker: 'jim', question: 'r?' }].map((r) => JSON.stringify(r)).join('\n'));
  assert.deepEqual(answererItems(itemsFile).map((i) => i.id), ['DV001', 'P1'], 'the DEV files name the id itemId');
  const dev = (command) => styleDeviation({ tool: 'Bash', command });
  assert.equal(dev('memory search "codex quota"'), false, 'bare');
  assert.equal(dev('memory search --results 3 "a | b > c; d"'), false, 'quoted query text is not a pipe');
  assert.equal(dev('memory wake-up'), false);
  for (const c of ['memory search "q" | head -50', 'memory search "q" 2>&1', 'memory search q #full', 'memory search a; memory search b', 'memory search a && memory wake-up', 'cat x', 'echo $(memory search q)']) assert.equal(dev(c), true, c);
  assert.equal(styleDeviation({ tool: 'Read', command: null }), false, 'a Read of a saved output is not a memory command');
  const answererSrc = codeOnly(readSource(path.join(__dirname, 'claims-90', 'answerer.cjs')));
  assert.match(answererSrc, /const code0 = codeAt\(\);/, 'the code is recorded when the run starts');
  assert.ok(answererSrc.indexOf('const code0 = codeAt();') < answererSrc.indexOf('await answerItem(o, v'), 'before the first item');
  assert.match(answererSrc, /codeAtEnd:/, 'a change by the end is recorded');
  const { itemStyle } = require('./claims-90/answerer.cjs');
  const call = (command) => ({ tool: 'Bash', command, styleDeviation: dev(command), readType: /\|/.test(command) });
  assert.deepEqual(itemStyle([call('memory search "q"'), call('memory wake-up')]), { allBare: true, calls: 2, readTypeCalls: 0, fullCalls: 0, styleDeviations: 0 });
  assert.deepEqual(itemStyle([call('memory search "q" #full'), call('memory search "q" | head -5')]), { allBare: false, calls: 2, readTypeCalls: 1, fullCalls: 1, styleDeviations: 2 });
  assert.equal(itemStyle([call('memory search "q"'), { tool: 'Read', command: null, styleDeviation: false }]).allBare, false, 'a Read of a saved output is not bare');
  const shape = { matcher: '*', timeout: 30, events: ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'] };
  const s = settingsFor(shape, 'http://127.0.0.1:1/hook/t', 'X:/b.txt', 'X:/jail/hive/agents/a/tool-output');
  for (const e of shape.events) assert.deepEqual(s.hooks[e], [{ matcher: '*', hooks: [{ type: 'http', url: 'http://127.0.0.1:1/hook/t', timeout: 30 }] }]);
  assert.deepEqual(Object.keys(s.hooks).sort(), ['PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'SessionStart']);
  assert.ok(s.permissions.deny.includes('Read(//c/Dunder/hive/**)'));
  const saved = process.env.PATH;
  process.env.PATH = ['C:\\Dunder\\hive\\bin\\memory', 'C:\\Windows'].join(path.delimiter);
  process.env.HIVE_PROBE = 'x';
  try {
    const env = childEnv('J:/bin', { MEMORY_TOKEN: 't' });
    assert.equal(env.PATH, ['J:/bin', 'C:\\Windows'].join(path.delimiter), 'no hive folder on PATH');
    assert.equal(env.HIVE_PROBE, undefined, 'an allow-list: nothing of the hive passes');
    assert.equal(env.MEMORY_TOKEN, 't');
  } finally { process.env.PATH = saved; delete process.env.HIVE_PROBE; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c90-tr-'));
  const f = path.join(dir, 't.jsonl');
  const use = (id, name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  fs.writeFileSync(f, [
    JSON.stringify({ type: 'system', subtype: 'init', tools: ['Bash', 'Read'], mcp_servers: [], plugins: [{ name: 'p', path: 'builtin' }] }),
    use('1', 'Bash', { command: 'memory search x' }),
    use('2', 'Bash', { command: 'cat C:/Dunder/hive/tasks.json' }),
    use('3', 'Read', { file_path: 'X:/other/file.txt' }),
    use('4', 'Read', { file_path: 'X:/jail/hive/agents/a/tool-output/toolu_1.txt' }),
    JSON.stringify({ type: 'result', result: 'current: x', is_error: false }),
  ].join('\n'));
  const t = readTranscript(f, 'X:/jail/hive/agents/a/tool-output', [/[\\/]+Dunder[\\/]+hive/i]);
  assert.deepEqual(t.leaks.map((l) => l.id), ['2', '3'], 'a live path and a Read outside the saved outputs');
  assert.equal(t.init.otherPlugins, 0);
  assert.equal(t.answer, 'current: x');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the addendum check names a changed file or another snapshot; refs at T_s come from the reflog', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c90-add-'));
  fs.writeFileSync(path.join(dir, 'world.json'), '{}');
  fs.writeFileSync(path.join(dir, 'addendum.json'), JSON.stringify({ snapshotManifestSha256: 'm1', files: [{ path: 'world.json', sha256: sha('{}') }] }));
  assert.deepEqual(verifyAddendum(dir, 'm1').diffs, []);
  assert.deepEqual(verifyAddendum(dir, 'm2').diffs, ['it names another snapshot']);
  fs.writeFileSync(path.join(dir, 'world.json'), '{"x":1}');
  assert.deepEqual(verifyAddendum(dir, 'm1').diffs, ['changed world.json']);
  fs.rmSync(dir, { recursive: true, force: true });
  const a = 'a'.repeat(40); const b = 'b'.repeat(40); const z = '0'.repeat(40);
  const log = [`${z} ${a} X <x> 100 +0000\tfetch`, `${a} ${b} X <x> 200 +0000\tfetch`].join('\n');
  assert.equal(valueAt(log, 99), null, 'not created yet');
  assert.equal(valueAt(log, 150), a);
  assert.equal(valueAt(log, 200), b, 'an entry at T_s counts');
  assert.equal(valueAt(`${log}\n${b} ${z} X <x> 300 +0000\tdelete`, 400), null, 'deleted before T_s');
});

test('C0b: memory.md reads (Read, or a read-only grep/cat/head/tail/sed -n) go to the T_s copy; the leak check accepts a live path only when the hook allowed that call', () => {
  const { memoryMdOf, memoryMdCommand } = require('./claims-90/memory-md.cjs');
  const { settingsFor, readTranscript, memoryMdUse } = require('./claims-90/answerer.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c90-mmd-'));
  const sbx = path.join(dir, 'hive');
  fs.mkdirSync(path.join(sbx, 'agents', 'a'), { recursive: true });
  fs.writeFileSync(path.join(sbx, 'agents', 'a', 'memory.md'), '## claim-history-c-1\nthe deploy moved to Friday after the freeze was lifted by god\n');
  const copy = path.join(sbx, 'agents', 'a', 'memory.md');
  const H = sbx.replace(/\\/g, '/');
  for (const live of ['C:/Dunder/hive/agents/a/memory.md', 'C:\\Dunder\\hive\\agents\\a\\memory.md', '/c/Dunder/hive/agents/a/memory.md', 'c:/dunder/HIVE/agents/a/memory.md']) {
    assert.deepEqual(memoryMdOf(live, sbx), { kind: 'live', agent: 'a', target: copy }, live);
  }
  assert.deepEqual(memoryMdOf(copy, sbx), { kind: 'sandbox', agent: 'a', target: copy });
  for (const no of ['C:/Dunder/hive/agents/b/memory.md', 'C:/Dunder/hive/agents/a/../a/memory.md', 'C:/Dunder/hive/agents/a/inbox/memory.md',
    'C:/Dunder/hive/memory.md', 'C:/Dunder/hive/agents/a/memory.md.bak', path.join(sbx, 'agents', 'a', 'other.md'), 'agents/a/memory.md', null]) {
    assert.equal(memoryMdOf(no, sbx), null, String(no));
  }
  // Bash: the allowed shapes, live rewritten, sandbox kept.
  const ok = {
    'grep -n "c-1" C:/Dunder/hive/agents/a/memory.md': ['grep', 'rewritten', `grep -n "c-1" '${H}/agents/a/memory.md'`],
    'grep -n -A 5 c-1 "$MUNDER_HIVE_ROOT/agents/a/memory.md" | head -20': ['grep', 'sandbox', null],
    'grep -n c-1 $MUNDER_HIVE_ROOT/agents/a/memory.md #full': ['grep', 'sandbox', null],
    "sed -n '/claim-history-c-1/,+12p' /c/Dunder/hive/agents/a/memory.md": ['sed', 'rewritten', null],
    'sed -n 10,20p C:/Dunder/hive/agents/a/memory.md': ['sed', 'rewritten', null],
    'tail -n 50 C:/Dunder/hive/agents/a/memory.md | grep -i deploy': ['tail', 'rewritten', null],
    'head -40 C:/Dunder/hive/agents/a/memory.md': ['head', 'rewritten', null],
    "cat 'C:\\Dunder\\hive\\agents\\a\\memory.md'": ['cat', 'rewritten', `cat '${H}/agents/a/memory.md'`],
  };
  for (const [c, [cmd, kind, out]] of Object.entries(ok)) {
    const r = memoryMdCommand(c, sbx);
    assert.ok(r, c);
    assert.deepEqual([r.cmd, r.kind, r.agents], [cmd, kind, ['a']], c);
    if (kind === 'sandbox') assert.equal(r.command, c, 'a sandbox command runs as typed');
    else assert.ok(!/Dunder[\\/]+hive/i.test(r.command) && r.command.includes(H), 'the live path is replaced by the copy');
    if (out) assert.equal(r.command, out);
  }
  for (const c of ['cd $MUNDER_HIVE_ROOT && grep x agents/a/memory.md', 'grep x C:/Dunder/hive/agents/a/memory.md > o', 'grep x C:/Dunder/hive/agents/a/memory.md; id',
    'grep x C:/Dunder/hive/agents/a/memory.md C:/Dunder/hive/tasks.json', 'grep -r x C:/Dunder/hive/agents/a/memory.md', 'grep -f C:/Dunder/hive/x C:/Dunder/hive/agents/a/memory.md',
    "sed -n '1w o' C:/Dunder/hive/agents/a/memory.md", "sed -n 'e id' C:/Dunder/hive/agents/a/memory.md", 'sed -i s/a/b/ C:/Dunder/hive/agents/a/memory.md', 'sed 1p C:/Dunder/hive/agents/a/memory.md',
    'grep x C:/Dunder/hive/agents/a/memory.md | sort', 'grep x C:/Dunder/hive/agents/a/memory.md | head -5 C:/Dunder/hive/tasks.json', 'grep x C:/Dunder/hive/agents/a/memory.md || id',
    'grep "$(id)" C:/Dunder/hive/agents/a/memory.md', 'grep x `id` C:/Dunder/hive/agents/a/memory.md', 'grep x $HOME/agents/a/memory.md', 'grep x C:/Dunder/hive/agents/*/memory.md',
    'grep x C:/Dunder/hive/agents/b/memory.md', 'grep x agents/a/memory.md', 'tail -f C:/Dunder/hive/agents/a/memory.md', 'grep x', 'awk 1 C:/Dunder/hive/agents/a/memory.md',
    'grep x C:/Dunder/hive/agents/a/memory.md # note']) {
    assert.equal(memoryMdCommand(c, sbx), null, c);
  }
  const shape = { matcher: '*', timeout: 30, events: ['PreToolUse'] };
  const st = settingsFor(shape, 'http://127.0.0.1:1/hook/t', 'X:/b.txt', 'X:/jail/hive/agents/a/tool-output', 'X:/jail/hive');
  assert.ok(st.permissions.allow.includes('Read(//x/jail/hive/agents/*/memory.md)'), 'the sandbox copy is readable');
  assert.deepEqual(st.permissions.allow.filter((r) => r.startsWith('Bash')), ['Bash(memory:*)'], 'no settings rule allows grep/cat: only the hook does, per call');
  assert.ok(!st.permissions.allow.some((r) => /dunder\/hive/i.test(r)), 'no allow rule reaches the live tree');
  assert.ok(!st.permissions.deny.includes('Read(//c/Dunder/hive/**)') && st.permissions.deny.includes('Edit(//c/Dunder/hive/**)'), 'a deny rule would beat the rewrite; Edit stays denied');
  // Leak check.
  const tf = path.join(dir, 't.jsonl');
  const use = (id, name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  const g = 'grep -n c-1 C:/Dunder/hive/agents/a/memory.md';
  fs.writeFileSync(tf, [
    use('1', 'Read', { file_path: 'C:/Dunder/hive/agents/a/memory.md' }),
    use('2', 'Read', { file_path: 'C:/Dunder/hive/agents/a/memory.md' }),
    use('3', 'Read', { file_path: copy }),
    use('4', 'Grep', { pattern: 'x', path: 'C:/Dunder/hive/agents/a/memory.md' }),
    use('5', 'Bash', { command: g }),
    use('6', 'Bash', { command: g }),
    use('7', 'Bash', { command: 'cat C:/Dunder/hive/tasks.json' }),
    use('8', 'Bash', { command: g + ' | sort' }),
  ].join('\n'));
  const hooked = new Map([
    ['1', { toolUseId: '1', memoryMd: { tool: 'Read', kind: 'rewritten' } }],
    ['5', { toolUseId: '5', command: g, memoryMd: { tool: 'grep', kind: 'rewritten' } }],
    ['7', { toolUseId: '7', command: 'cat C:/Dunder/hive/tasks.json', memoryMd: { tool: 'cat', kind: 'rewritten' } }],
    ['8', { toolUseId: '8', command: g, memoryMd: { tool: 'grep', kind: 'rewritten' } }],
  ]);
  const r = readTranscript(tf, 'X:/jail/hive/agents/a/tool-output', [/[\\/]+Dunder[\\/]+hive/i], { sandboxHive: sbx, hooked });
  assert.deepEqual([...new Set(r.leaks.map((l) => l.id))], ['2', '4', '6', '7', '8'], 'no hook row, a command the rule refuses, or a command other than the hooked one: a leak');
  assert.deepEqual(r.memoryMdCalls.map((m) => [m.id, m.tool, m.kind]), [['1', 'Read', 'rewritten'], ['3', 'Read', 'sandbox'], ['5', 'grep', 'rewritten']]);
  const use1 = memoryMdUse(r.memoryMdCalls, 'Per its history: the deploy moved to Friday after the freeze was lifted.', sbx);
  assert.deepEqual(use1, { calls: 3, byCommand: { Read: 2, grep: 1 }, rewritten: 2, sandbox: 1, quoted: true });
  assert.equal(memoryMdUse(r.memoryMdCalls, 'not in memory', sbx).quoted, false);
  assert.deepEqual(memoryMdUse([], 'x', sbx), { calls: 0, byCommand: {}, rewritten: 0, sandbox: 0, quoted: false });
  // The serve hook: the call limit first; Read and Bash through the shared rule; any other live Read denied.
  const child = fs.readFileSync(path.join(__dirname, 'claims-90', 'answer-child.cjs'), 'utf8');
  const at = (x) => { const i = child.indexOf(x); assert.ok(i > 0, x); return i; };
  assert.ok(at("row.denied = 'call limit'") < at('memoryMdOf(p.tool_input'), 'the 5-call limit comes first');
  assert.ok(at('memoryMdOf(p.tool_input') < at("row.denied = 'live hive'"));
  assert.match(child, /permissionDecision: 'allow', updatedInput: \{ \.\.\.p\.tool_input, file_path: m\.target \} \}/);
  assert.match(child, /p\.tool_name === 'Bash' \? memoryMdCommand\(command, hive\)/);
  assert.match(child, /permissionDecision: 'allow', updatedInput: \{ \.\.\.p\.tool_input, command: b\.command \} \}/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--build: the branch build is the tree, its out/ the hook shape, its Electron and memory-cli the shim; run.json identity (god 7fea2c)', () => {
  const A = require('./claims-90/answerer.cjs');
  const { execFileSync } = require('node:child_process');
  const base = ['--snapshot', 's', '--addendum', 'a', '--items', 'i', '--instruction', 'n', '--out', 'o', '--claude', 'c'];
  const build = fs.mkdtempSync(path.join(os.tmpdir(), 'c90-build-'));
  const o = A.parseArgs([...base, '--build', build]);
  assert.equal(o.build, path.resolve(build));
  assert.equal(o.tree, path.resolve(build), 'the build is the tree');
  assert.equal(A.parseArgs([...base, '--build', build, '--tree', build]).tree, path.resolve(build), 'the same tree twice is fine');
  assert.throws(() => A.parseArgs([...base, '--build', build, '--tree', os.tmpdir()]), /--tree and --build name different trees/);
  assert.match(A.parseArgs(base).resources, /Guppy[\\/]resources$/, 'no build: the installed resources');
  assert.match(o.resources, /Guppy[\\/]resources$/, 'a build keeps the installed resources (the models)');

  assert.throws(() => A.buildHookShape(build), /no out\/main\/index\.js/);
  const js = [
    'const HOOK_HTTP_TIMEOUT_S = 30;',
    'const hook = (matcher) => hookUrl ? { ...matcher ? { matcher } : {}, hooks: [{ type: "http", url: hookUrl, timeout: HOOK_HTTP_TIMEOUT_S }] } : entry(matcher)',
    'PreToolUse: [hook("*")], PostToolUse: [hook("*")], PostToolUseFailure: [hook("*")]',
  ].join('\n');
  fs.mkdirSync(path.join(build, 'out', 'main'), { recursive: true });
  fs.writeFileSync(path.join(build, 'out', 'main', 'index.js'), js);
  const shape = A.buildHookShape(build);
  assert.equal(shape.asarSha256, null);
  assert.equal(shape.mainSha256, sha(js));
  assert.equal(shape.timeout, 30);
  assert.deepEqual(shape.events, ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
  assert.throws(() => A.hookShapeOf(js.replace('PostToolUseFailure: [hook("*")]', ''), 'x'), /x does not wire the tool hooks/);

  const electron = path.join(build, 'electron.exe');
  fs.writeFileSync(electron, '');
  fs.mkdirSync(path.join(build, 'node_modules', 'electron'), { recursive: true });
  fs.writeFileSync(path.join(build, 'node_modules', 'electron', 'index.js'), `module.exports = ${JSON.stringify(electron)};`);
  const bin = path.join(build, 'jail-bin');
  assert.throws(() => A.buildMemoryShim(bin, build), /no resources\/memory-cli\.cjs/);
  fs.mkdirSync(path.join(build, 'resources'));
  fs.writeFileSync(path.join(build, 'resources', 'memory-cli.cjs'), 'cli');
  const shim = A.buildMemoryShim(bin, build);
  const text = fs.readFileSync(path.join(bin, 'memory'), 'utf8');
  const f = (p) => p.replace(/\\/g, '/');
  assert.equal(text, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${f(electron)}" "${f(path.join(build, 'resources', 'memory-cli.cjs'))}" "$@"\n`);
  assert.equal(shim.memoryCliSha256, sha('cli'));
  assert.equal(shim.sha256, sha(text.split(f(build)).join('<build>')), 'the shim sha does not depend on where the build sits');

  const git = (...a) => execFileSync('git', ['-C', build, ...a], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('add', 'out', 'resources');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 't');
  let info = A.buildInfo(build);
  assert.equal(info.commit, git('rev-parse', 'HEAD'));
  assert.equal(info.dirty, '');
  assert.equal(info.outMainSha256, sha(js));
  assert.equal(info.memoryCliSha256, sha('cli'));
  assert.equal(info.asarSha256, null, 'no dist asar');
  assert.equal(info.dir, path.basename(build));
  fs.writeFileSync(path.join(build, 'resources', 'memory-cli.cjs'), 'cli2');
  info = A.buildInfo(build);
  assert.match(info.dirty, /memory-cli\.cjs/, 'a changed resource shows');
  const out1 = info.outSha256;
  fs.writeFileSync(path.join(build, 'out', 'main', 'extra.js'), 'x');
  assert.notEqual(A.buildInfo(build).outSha256, out1, 'out/ is hashed as a whole');
  fs.mkdirSync(path.join(build, 'dist', 'win-unpacked', 'resources'), { recursive: true });
  fs.writeFileSync(path.join(build, 'dist', 'win-unpacked', 'resources', 'app.asar'), 'asar');
  assert.equal(A.buildInfo(build).asarSha256, sha('asar'));
  fs.rmSync(build, { recursive: true, force: true });

  const src = codeOnly(readSource(path.join(__dirname, 'claims-90', 'answerer.cjs')));
  assert.match(src, /const shape = o\.build \? buildHookShape\(o\.build\) : installedHookShape\(o\.resources\);/);
  assert.match(src, /o\.build \? buildMemoryShim\(/, 'the jail shim is the build\'s');
  assert.match(src, /hookEqualsInstalled: sameHook\(shape, installedHookShape\(o\.resources\)\)/);
  assert.match(src, /const Condense = condenseOf\(o\.tree\);/, 'the condenser is the build\'s');
});
