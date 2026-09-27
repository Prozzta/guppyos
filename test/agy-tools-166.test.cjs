'use strict';
/**
 * AGY-TOOLS-166. From 1.1.55 (AGY-STARTUP-TURN) an AGY hive agent runs as agy custom agent
 * `--agent munder-<id>`. A Markdown custom agent gets ONLY agy's fundamental tools (view_file,
 * search_web, send_message, manage_task) unless its frontmatter lists `tools`, so a FRESH
 * conversation could not run a command or write a file: no outbox, no inbox move, no
 * deliverable (Phyllis on 1.1.65; Jim's PHYLLIS-NO-MAIL-WHY.md). Latent while she resumed an old
 * default-agent conversation; 1.1.65's rotation exposed it.
 *
 * The fix, verified in a jailed agy (C:/Dunder/_work/agy-tools/AGY-TOOLS-PROBE.md):
 * - the agent.md lists the tools a hive agent needs (agy rejects the WHOLE agent on one unknown
 *   name, exit 3, and has no wildcard, so the list is pinned to registry-verified names);
 * - agy fixes a conversation's toolset when it is CREATED, so an automatic resume of a
 *   conversation from before the list starts fresh (reason agy-toolset).
 * The live half (a real fresh conversation runs run_command + write_to_file) is the probe gate:
 * test/tools/agy-tools-gate.cjs.
 *
 * EVERY TEST REDIRECTS HOME AND ASSERTS IT before building a hive (the 2026-09-23 incident).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const R = loadTs('src/main/codexThreadRotation.ts');
const REPO = path.resolve(__dirname, '..');

/** Every tool name agy's registry accepted in the jailed probe (agy 2026-09-27 build). A name
 *  outside this set would make `agy --agent` exit 3; widen it only after the live gate passes. */
const REGISTRY_VERIFIED = new Set(['run_command', 'view_file', 'write_to_file', 'replace_file_content',
  'multi_replace_file_content', 'search_web', 'read_url_content', 'manage_task']);

function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-tools-'));
  const realHome = process.env.HOME; const realProfile = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
  });
  assert.equal(os.homedir(), home, 'HOME redirect failed - aborting before constructing any hive');
  const hiveHome = path.join(home, 'harness');
  const hive = new HiveManager(() => hiveHome, undefined, {}, () => true);
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  return { home, hiveHome, hive };
}
const agentFile = (home, id) => path.join(home, '.gemini', 'config', 'agents', `munder-${id}`, 'agent.md');
const toolsOf = (md) => {
  const fm = md.split('\n---\n')[0];
  const m = /\ntools:\n((?:  - [^\n]+\n?)+)/.exec(fm + '\n');
  return m ? m[1].trim().split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim()) : null;
};

// ── the agent.md tool list ─────────────────────────────────────────────────────────────────

test('the agent.md frontmatter lists tools, including run_command, write_to_file and replace_file_content', () => {
  const tools = toolsOf(HiveManager.agyAgentMarkdown({ id: 'phyllis-mu11xldm', name: 'Phyllis' }, 'p'));
  assert.ok(tools, 'a tools: list in the frontmatter');
  for (const need of ['run_command', 'write_to_file', 'replace_file_content', 'view_file']) assert.ok(tools.includes(need), need);
});

test('every listed tool is a registry-verified name, with no wildcard and no duplicate (agy exits 3 on one bad name)', () => {
  const tools = toolsOf(HiveManager.agyAgentMarkdown({ id: 'x1', name: 'X' }, 'p'));
  for (const t of tools) assert.ok(REGISTRY_VERIFIED.has(t), `unverified tool name: ${t}`);
  assert.ok(!tools.some((t) => t.includes('*')), 'no wildcard');
  assert.equal(new Set(tools).size, tools.length, 'no duplicates');
  assert.deepEqual([...HiveManager.AGY_AGENT_TOOLS], tools, 'the list is the exported constant');
});

test('the tools block sits in the FRONTMATTER (before the closing ---), not in the prompt body', () => {
  const md = HiveManager.agyAgentMarkdown({ id: 'x1', name: 'X' }, 'tools:\n  - evil');
  const [fm] = md.split('\n---\n\n# ');
  assert.match(fm, /\ntools:\n  - run_command\n/);
  assert.equal((md.match(/^tools:$/gm) || []).length, 2, 'the prompt text stays prompt text');
});

// ── the tools-since marker and the rotation ─────────────────────────────────────────────────

test('a new AGY agent records when its agy agent got the tools (in the hive agent folder, not ~/.gemini)', async (t) => {
  const s = sandbox(t);
  const before = Date.now();
  await s.hive.ensureAgent({ id: 'p1', name: 'Pat', provider: 'antigravity', cwd: s.home });
  const since = s.hive.agyToolsSince('p1');
  assert.ok(since !== null && since >= before && since <= Date.now(), `since=${since}`);
  assert.ok(fs.existsSync(path.join(s.hiveHome, 'hive', 'agents', 'p1', HiveManager.AGY_TOOLS_SINCE_FILE))
    || fs.readdirSync(s.hiveHome, { recursive: true }).some((f) => String(f).endsWith(HiveManager.AGY_TOOLS_SINCE_FILE)));
  assert.ok(!fs.readdirSync(path.join(s.home, '.gemini', 'config', 'agents', 'munder-p1')).includes(HiveManager.AGY_TOOLS_SINCE_FILE));
});

test('upgrading a pre-1.1.66 agent.md (no tools:) records the moment; a later rewrite that already had tools does not move it', async (t) => {
  const s = sandbox(t);
  await s.hive.ensureAgent({ id: 'p2', name: 'Pam', provider: 'antigravity', cwd: s.home });
  const f = agentFile(s.home, 'p2');
  // Simulate the 1.1.65 file: the same agent, without the tools block.
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/tools:\n(  - [a-z_]+\n)+/, ''));
  const marker = fs.readdirSync(s.hiveHome, { recursive: true }).map(String).find((p) => p.endsWith(HiveManager.AGY_TOOLS_SINCE_FILE));
  fs.writeFileSync(path.join(s.hiveHome, marker), '1');
  await s.hive.ensureAgent({ id: 'p2', name: 'Pam', provider: 'antigravity', cwd: s.home });
  const upgraded = s.hive.agyToolsSince('p2');
  assert.ok(upgraded > 1, 'the upgrade re-records the moment');
  assert.match(fs.readFileSync(f, 'utf8'), /\ntools:\n/);
  await s.hive.ensureAgent({ id: 'p2', name: 'Pamela', provider: 'antigravity', cwd: s.home }); // prompt change, tools already there
  assert.equal(s.hive.agyToolsSince('p2'), upgraded, 'unchanged by a rewrite that already had tools');
});

test('decideAgyRotation: a conversation created before the tools list ROTATES (agy-toolset), even today and small', () => {
  const now = new Date(2026, 8, 27, 22, 0, 0).getTime();
  const since = now - 60_000;
  const d = R.decideAgyRotation({ path: 'x', bytes: 10, startedAt: since - 1 }, now, since);
  assert.equal(d.rotate, true);
  assert.equal(d.reason, 'agy-toolset');
});

test('decideAgyRotation: created after the tools list -> the usual size/day rules; no marker -> the usual rules', () => {
  const now = new Date(2026, 8, 27, 22, 0, 0).getTime();
  const since = now - 60_000;
  assert.equal(R.decideAgyRotation({ path: 'x', bytes: 10, startedAt: since + 1 }, now, since).rotate, false);
  assert.equal(R.decideAgyRotation({ path: 'x', bytes: 30 * 1024 * 1024, startedAt: since + 1 }, now, since).reason, 'size');
  assert.equal(R.decideAgyRotation({ path: 'x', bytes: 10, startedAt: now - 1000 }, now, null).rotate, false);
});

test('wiring: the AGY automatic-resume branch uses decideAgyRotation with the agent\'s tools-since, still gated on mayRotate', () => {
  const idx = fs.readFileSync(path.join(REPO, 'src', 'main', 'index.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(idx, /if \(sid && rf && mayRotate && provider === 'antigravity'\) \{[\s\S]{0,400}decideAgyRotation\(info, Date\.now\(\), hive\.agyToolsSince\(opts\.hive\.id\)\)/);
  assert.match(idx, /const mayRotate = !typedSid && opts\.requireResume !== true;/, 'a typed id and Restart & Continue never rotate');
});
