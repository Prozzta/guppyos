'use strict';

// NEW-FLOOR-KNOWHOW: a fresh floor learns the floor tools from the shipped text (PROTOCOL.md,
// COMMANDS.md, god's orientation and start-up line), not from older agents' memory. Each pin ties a
// line of that text to the code it describes, so a renamed flag or key turns this red.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');
const between = (s, a, b) => {
  const i = s.indexOf(a);
  assert.ok(i >= 0, `missing ${a}`);
  const j = s.indexOf(b, i + a.length);
  assert.ok(j > i, `missing ${b} after ${a}`);
  return s.slice(i, j);
};
const HIVE = read('src/main/hive.ts');
const LEDGER = read('src/main/ledger.ts');
const PROTOCOL = between(HIVE, 'const PROTOCOL_MD = `# Hive protocol', '// ─── cth-hook shim');
const FLOOR = between(HIVE, 'const FLOOR_COMMANDS_MD = [', '\n];');
const keySet = (name) => new Set([...between(LEDGER, `const ${name} = new Set([`, '])').matchAll(/'([A-Za-z_]+)'/g)].map((m) => m[1]));

test('COMMANDS.md carries the floor commands and fleet settings', () => {
  const render = between(HIVE, 'function renderCommandsMd(): string {', '\nconst COMMANDS_MD');
  assert.match(render, /lines\.push\(\.\.\.FLOOR_COMMANDS_MD\);\n {2}return lines\.join/, 'appended after the Claude Code groups');
  assert.match(FLOOR, /## FLOOR COMMANDS/);
  assert.match(FLOOR, /## FLEET SETTINGS \(god\)/);
});

test('every memory verb and flag named is one memory-cli accepts', () => {
  const cli = read('resources/memory-cli.cjs');
  const verbs = new Set([...between(cli, 'const CLAIM_VERBS = new Set([', '])').matchAll(/'([a-z-]+)'/g)].map((m) => m[1]));
  for (const v of ['note', 'retract', 'reconcile', 'used']) {
    assert.ok(verbs.has(v), `memory ${v} is a claim verb`);
    assert.ok(FLOOR.includes(`\`memory ${v} `), `COMMANDS.md names memory ${v}`);
  }
  const usage = between(cli, 'const USAGE =', '\nconst ');
  for (const flag of ['--wing', '--results', '--since', '--before', '--kind', '--key', '--history', '--supersedes', '--reason', '--separate', '--cancel', '--why', '--answer', '--op']) {
    assert.ok(usage.includes(flag), `memory-cli usage has ${flag}`);
    assert.ok(FLOOR.includes(flag), `COMMANDS.md names ${flag}`);
  }
  assert.ok(usage.includes('changed|corrected|moved') && FLOOR.includes('changed|corrected|moved'));
  assert.ok(usage.includes('keep-both|supersedes|retract') && FLOOR.includes('keep-both|supersedes|retract'));
});

test('the heavy, term and tasks lines match their CLIs', () => {
  const heavy = read('resources/heavy-cli.cjs');
  assert.match(heavy, /'usage: heavy status \| heavy release \[--to <agent>\]\\n'/);
  assert.ok(FLOOR.includes('`heavy status`') && FLOOR.includes('`heavy release [--to <agent>]`'));
  const term = read('resources/term-cli.cjs');
  for (const a of ['read', 'type', 'send', 'keys']) assert.ok(FLOOR.includes(`\`term ${a} <agent>`), `term ${a}`);
  assert.ok(FLOOR.includes('`term hold on [reason]`') && FLOOR.includes('`term hold off`'));
  assert.match(term, /if \(action === 'read'\)[\s\S]*?rest\[0\] === '--rows'/, 'term read takes --rows');
  for (const k of ['enter', 'esc', 'tab', 'shift-tab', 'ctrl-c', 'ctrl-u']) assert.match(term, new RegExp(` ${k} `), `term key ${k}`);
  assert.match(term, /refuses a lone "\?" and a leading "!" or "\/" \(they act as keys\) unless --raw/);
  const tasks = read('resources/tasks-cli.cjs');
  assert.match(tasks, /'usage: tasks-all \| tasks-revive <CARD-ID> \| tasks-unsplit --yes/);
  assert.ok(FLOOR.includes('`tasks-all`') && FLOOR.includes('`tasks-revive <CARD-ID>`') && FLOOR.includes('`tasks-unsplit --yes`'));
});

test('the compaction window line names the registry key and config keys the app reads', () => {
  assert.match(HIVE, /\n {2}autoCompactWindow\?: number \| 'off';/);
  const config = read('src/main/config.ts');
  for (const k of ['claudeAutoCompactWindow', 'godAutoCompactWindow']) assert.match(config, new RegExp(`\\n {2}${k}\\?: number \\| 'off';`), k);
  assert.match(config, /Unset = 150000/);
  for (const k of ['`agents.<id>.autoCompactWindow`', '`claudeAutoCompactWindow`', '`godAutoCompactWindow`', 'default 150000', '`codexAutoCompactTokenLimit`', 'at spawn']) {
    assert.ok(FLOOR.includes(k), `FLEET SETTINGS names ${k}`);
  }
  assert.match(read('src/shared/autoCompactWindow.ts'), /AUTO_COMPACT_WINDOW_ENV = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'/);
});

test('PROTOCOL.md lists the ledger card, message and memory keys exactly as ledger.ts takes them', () => {
  const create = keySet('CREATE_KEYS');
  const patch = keySet('PATCH_KEYS');
  for (const k of create) assert.ok(PROTOCOL.includes(`\\\`${k}\\\``), `create key ${k} named`);
  for (const k of [...patch].filter((k) => !create.has(k))) assert.ok(PROTOCOL.includes(`\\\`${k}\\\``), `patch key ${k} named`);
  assert.equal(create.has('humanQA') || patch.has('humanQA'), false);
  assert.match(PROTOCOL, /Neither takes \\`humanQA\\` or tags\./);
  assert.match(LEDGER, /\$\{where\}\.priority: a number/);
  assert.match(PROTOCOL, /\\`priority\\` \(a number\)/);
  assert.equal(keySet('MESSAGE_KEYS').has('wake'), false, 'the ledger message has no wake');
  assert.match(PROTOCOL, /without \\`wake\\` \(for \\`"wake": "now"\\` write an outbox file\)/);
  const memory = keySet('MEMORY_KEYS');
  for (const k of ['key', 'supersedes', 'reason', 'separate']) {
    assert.ok(memory.has(k), `ledger memory takes ${k}`);
    assert.ok(between(PROTOCOL, '- \\`memory\\`: \\`append\\`', 'In PowerShell').includes(`\\\`${k}\\\``), `PROTOCOL names memory ${k}`);
  }
});

test('PROTOCOL.md states the heavy-slot rule and points claim-ledger agents at memory note', () => {
  const heavy = between(PROTOCOL, '## The heavy slot', '\n`;');
  assert.match(heavy, /QUEUED: do not retry it or a variant, and do not poll/);
  assert.match(heavy, /"HEAVY SLOT FREE" reserves the slot for you\nfor 5 minutes/);
  assert.match(heavy, /\\`GUPPY_BENCH=1\\` as the command's FIRST token/);
  assert.match(heavy, /\\`heavy status\\`.*\\`heavy release\\`/);
  assert.match(PROTOCOL, /record facts with \\`memory note\\` instead/);
});

test('god meets the new sections at a fresh spawn (orientation) and at every spawn (start-up line)', () => {
  const orient = read('src/shared/godOrientation.ts');
  assert.match(orient, /'4\. Skim COMMANDS\.md \(hive root\): the Claude Code commands, then FLOOR COMMANDS \(term read\/type\/send\/keys\/hold, heavy, memory note, tasks-all\) and FLEET SETTINGS \(per-agent autoCompactWindow, parked\/waitingFor, ASK ME options\)/);
  assert.match(orient, /run `memory wake-up`/, 'memory-command-160 still finds the wake-up line');
  assert.match(HIVE, /its FLOOR COMMANDS and FLEET SETTINGS sections give the term, heavy, memory and tasks syntax and the per-agent compaction window\./);
});
