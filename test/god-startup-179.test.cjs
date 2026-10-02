'use strict';
// GOD-STARTUP-TOKENS R1-R3 (1.1.79, Jim; diagnosis hive/agents/jim-mtujpe28/GOD-STARTUP-1M-TOKENS-045.md):
//   R1  an AUTOMATIC god resume starts FRESH, with a handoff in context, when the last session is
//       over 150K tokens, past the 1 h cache lifetime, from another Claude Code version, or on
//       another model; otherwise it resumes as before. The decision is logged with its reasons.
//   R2  the orientation prompt points at floor-digest.md + board-status.md, not the raw board.
//   R3  the card and fleet.json show billed-equivalent tokens; the raw sum is kept beside them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-god-startup-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL; process.env.CODEX_HOME = path.join(JAIL, '.codex'); process.env.GEMINI_CLI_HOME = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const G = loadTs('src/main/godStartup.ts');
const TW = loadTs('src/shared/tokenWeights.ts');
const { sessionTranscriptPath } = loadTs('src/main/transcript.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');

const SID = '3ec35b7b-0000-4000-8000-000000000001';
const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const OPUS = 'claude-opus-5-5';
const CURRENT = { cliVersion: '2.1.287', model: `${OPUS}[1m]` };

/** One assistant request line, in the shape Claude Code 2.1.287 writes it (fields trimmed). */
function assistantLine({ at = NOW - 5 * 60_000, version = '2.1.287', model = OPUS, read = 100_000, write = 500, input = 2, output = 30, sidechain = false } = {}) {
  return JSON.stringify({
    parentUuid: 'p', isSidechain: sidechain, type: 'assistant', timestamp: new Date(at).toISOString(), version, sessionId: SID,
    message: { model, role: 'assistant', usage: { input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output, cache_creation: { ephemeral_1h_input_tokens: write, ephemeral_5m_input_tokens: 0 } } }
  });
}
const userLine = (at) => JSON.stringify({ type: 'user', timestamp: new Date(at).toISOString(), message: { role: 'user', content: 'hi' } });

// ─── R1: the facts and the decision, rule by rule ───────────────────────────

test('R1 facts: the LAST main-thread assistant request (context = input + cache read + cache write + output), its time, version and model', () => {
  const tail = [
    assistantLine({ at: NOW - 3_600_000, read: 1 }),
    userLine(NOW - 1000),
    assistantLine({ read: 200_000, write: 1_000, input: 3, output: 50 }),
    assistantLine({ read: 999_999, sidechain: true }),        // a subagent's line is not god's context
    '{"type":"summary"}', 'garbage'
  ].join('\n');
  assert.deepEqual(G.godSessionFactsFromTail(tail), { contextTokens: 201_053, lastRequestAt: NOW - 5 * 60_000, cliVersion: '2.1.287', model: OPUS });
  assert.deepEqual(G.godSessionFactsFromTail('{"type":"user"}'), { contextTokens: null, lastRequestAt: null, cliVersion: null, model: null });
  const file = path.join(JAIL, 't.jsonl');
  fs.writeFileSync(file, `${'x'.repeat(G.GOD_TRANSCRIPT_TAIL_BYTES)}\n${assistantLine({ read: 7 })}\n`);
  assert.equal(G.readGodSessionFacts(file).contextTokens, 7 + 500 + 2 + 30, 'only the tail is read');
  assert.equal(G.readGodSessionFacts(path.join(JAIL, 'missing.jsonl')).contextTokens, null);
});

const facts = (over = {}) => ({ contextTokens: 100_000, lastRequestAt: NOW - 10 * 60_000, cliVersion: '2.1.287', model: OPUS, ...over });

test('R1 RESUME: a session within every limit resumes, as before', () => {
  assert.deepEqual(G.godResumeDecision(facts(), NOW, CURRENT), { fresh: false, reasons: [] });
  assert.deepEqual(G.godResumeDecision(facts({ contextTokens: G.GOD_RESUME_MAX_CONTEXT, lastRequestAt: NOW - G.GOD_RESUME_CACHE_MS }), NOW, CURRENT), { fresh: false, reasons: [] }, 'the limits themselves still resume');
});

test('R1 SIZE: over 150K tokens of context starts fresh', () => {
  assert.deepEqual(G.godResumeDecision(facts({ contextTokens: G.GOD_RESUME_MAX_CONTEXT + 1 }), NOW, CURRENT), { fresh: true, reasons: ['context-over-limit'] });
  assert.equal(G.GOD_RESUME_MAX_CONTEXT, 150_000);
});

test('R1 AGE: a last request older than the 1 h cache lifetime starts fresh', () => {
  assert.deepEqual(G.godResumeDecision(facts({ lastRequestAt: NOW - G.GOD_RESUME_CACHE_MS - 1 }), NOW, CURRENT), { fresh: true, reasons: ['cache-expired'] });
  assert.equal(G.GOD_RESUME_CACHE_MS, 3_600_000);
});

test('R1 CLI VERSION: a Claude Code update since the last request starts fresh; an unknown version is no reason', () => {
  assert.deepEqual(G.godResumeDecision(facts({ cliVersion: '2.1.286' }), NOW, CURRENT), { fresh: true, reasons: ['cli-version-changed'] });
  assert.equal(G.godResumeDecision(facts({ cliVersion: null }), NOW, CURRENT).fresh, false);
  assert.equal(G.godResumeDecision(facts({ cliVersion: '2.1.286' }), NOW, { ...CURRENT, cliVersion: null }).fresh, false);
});

test('R1 MODEL: another model starts fresh; the [1m] variant and an alias are not "another model"', () => {
  assert.deepEqual(G.godResumeDecision(facts({ model: 'claude-fable-5-1' }), NOW, CURRENT), { fresh: true, reasons: ['model-changed'] });
  assert.equal(G.godResumeDecision(facts({ model: OPUS }), NOW, { ...CURRENT, model: OPUS }).fresh, false);
  assert.equal(G.godResumeDecision(facts({ model: 'claude-fable-5-1' }), NOW, { ...CURRENT, model: 'opus' }).fresh, false, 'an alias the CLI resolves cannot be compared');
  assert.equal(G.godResumeDecision(facts({ model: 'claude-fable-5-1' }), NOW, { ...CURRENT, model: null }).fresh, false);
});

test('R1: every reason is reported; unknown facts are never a reason', () => {
  assert.deepEqual(G.godResumeDecision({ contextTokens: 509_697, lastRequestAt: NOW - 86_400_000, cliVersion: '2.1.200', model: 'claude-opus-4-8' }, NOW, CURRENT).reasons,
    ['context-over-limit', 'cache-expired', 'cli-version-changed', 'model-changed']);
  assert.deepEqual(G.godResumeDecision({ contextTokens: null, lastRequestAt: null, cliVersion: null, model: null }, NOW, CURRENT), { fresh: false, reasons: [] });
});

/** godFreshStart over a real transcript file, with recording deps. */
function freshStart(line, current = CURRENT) {
  const dir = fs.mkdtempSync(path.join(JAIL, 'proj-'));
  const file = path.join(dir, `${SID}.jsonl`);
  if (line) fs.writeFileSync(file, `${userLine(NOW - 600_000)}\n${line}\n`);
  const rec = { rows: [], retired: [], armed: [] };
  const out = G.godFreshStart(SID, {
    agentId: 'god', current, now: () => NOW,
    transcriptPath: (id) => (id === SID && fs.existsSync(file) ? file : null),
    log: (r) => rec.rows.push(r), retire: (s) => rec.retired.push(s), arm: (h) => rec.armed.push(h)
  });
  return { out, ...rec };
}

test('R1 wiring unit (godFreshStart): fresh = logged with its reasons, the session retired, the handoff armed', () => {
  const r = freshStart(assistantLine({ read: 490_000, at: NOW - 2 * 3_600_000 }));
  assert.deepEqual(r.out, ['context-over-limit', 'cache-expired']);
  assert.deepEqual(r.retired, [SID]);
  assert.deepEqual(r.armed, [{ reasons: ['context-over-limit', 'cache-expired'], previousSession: SID, contextTokens: 490_532 }]);
  assert.deepEqual(r.rows, [{
    kind: 'god-startup-fresh', agentId: 'god', sessionId: SID, reasons: ['context-over-limit', 'cache-expired'], contextTokens: 490_532, ageMs: 2 * 3_600_000,
    cliVersion: { was: '2.1.287', now: '2.1.287' }, model: { was: OPUS, now: `${OPUS}[1m]` }
  }]);
});

test('R1 wiring unit: a resume is logged too (god-startup-resume), nothing retired or armed; no transcript = no decision', () => {
  const r = freshStart(assistantLine());
  assert.equal(r.out, null);
  assert.equal(r.rows[0].kind, 'god-startup-resume');
  assert.deepEqual(r.rows[0].reasons, []);
  assert.deepEqual([r.retired, r.armed], [[], []]);
  const none = freshStart(null);
  assert.deepEqual([none.out, none.rows, none.retired, none.armed], [null, [], [], []]);
});

test('R1 wiring in index.ts: an AUTOMATIC god resume only; the last key and the previous-key fallback both pass the rule', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(src, /const godCurrent = opts\.hive\.isGod && !explicitSid && sid\s+\? \{ cliVersion: readClaudeVersion\(await ptyManager\.commandPath\(/);
  assert.match(src, /model: modelFlagValue\(args\) \?\? null \}/);
  assert.match(src, /if \(sid && !explicitSid && godFresh\(sid\)\) \{[\s\S]{0,200}sid = undefined;/);
  assert.match(src, /if \(staleFor\(s\)\) \{ rotated\.push\(s\); return false; \}\s+if \(godFresh\(s\)\) return false;/);
  assert.match(src, /retire: \(id\) => hive\.retireSession\(godAgentId, id\),\s+arm: \(h\) => hive\.armGodHandoff\(godAgentId, h\)/);
  // SESSION-PROMPT-ROTATION: a god rotated for its prompt gets the handoff too.
  assert.match(src, /if \(opts\.hive\.isGod\) hive\.armGodHandoff\(opts\.hive\.id, \{ reasons: \[`prompt-\$\{why\}`\], previousSession: sid, contextTokens: null \}\);/);
});

test('R1: the installed Claude Code version comes from its npm package.json (no process); a native install is unknown', () => {
  const prefix = fs.mkdtempSync(path.join(JAIL, 'npm-'));
  const pkg = path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.287' }));
  fs.writeFileSync(path.join(prefix, 'claude.cmd'), '@echo off');
  assert.equal(G.readClaudeVersion(path.join(prefix, 'claude.cmd')), '2.1.287');
  assert.equal(G.readClaudeVersion(path.join(JAIL, 'elsewhere', 'claude.exe')), null);
  assert.equal(G.readClaudeVersion(null), null);
});

test('R1: sessionTranscriptPath finds the transcript in the cwd\'s project dir, else any project dir, without copying', () => {
  const cwd = path.join(JAIL, 'hivehome');
  fs.mkdirSync(cwd, { recursive: true });
  const other = path.join(JAIL, '.claude', 'projects', 'C--elsewhere');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, `${SID}.jsonl`), assistantLine());
  assert.equal(sessionTranscriptPath(cwd, SID), path.join(other, `${SID}.jsonl`));
  assert.equal(sessionTranscriptPath(cwd, 'not-there'), null);
  assert.equal(sessionTranscriptPath(cwd, '../x'), null);
});

// ─── R1: the handoff ────────────────────────────────────────────────────────

const GOD_MEMORY = '# god memory\n\n## How I work (standing lessons)\n- Never read tasks.json whole.\n- Route big work to low-ctx agents.\n\n## 2026-10-01\n- an old note that is NOT a standing lesson\n';

async function floor(t) {
  const home = fs.mkdtempSync(path.join(JAIL, 'floor-'));
  const hive = new HiveManager(() => home, () => true);
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  const root = hive.root();
  fs.writeFileSync(path.join(root, 'agents', 'god-1', 'memory.md'), GOD_MEMORY);
  fs.writeFileSync(path.join(root, 'floor-digest.md'), '# Floor digest\n\n## Decisions needed\n\nNone.\n');
  fs.writeFileSync(path.join(root, 'board-status.md'), '# Board status\n\n## In flight\n\n| Card | Assignee |\n');
  const server = new HookServer(hive, () => null, () => ({ notifications: false }), undefined, undefined);
  const fire = (agent_id, hook_event_name, extra = {}) => server.handle({ agent_id, hook_event_name, session_id: 's-new', transport: 'http', ...extra });
  return { hive, root, server, fire };
}
const ctx = (res) => res?.hookSpecificOutput?.additionalContext ?? '';

test('R1 HANDOFF: the fresh god\'s SessionStart(startup) carries why, its standing lessons, the digest and the board status, once', async (t) => {
  const { hive, fire } = await floor(t);
  hive.armGodHandoff('god-1', { reasons: ['context-over-limit', 'cache-expired'], previousSession: SID, contextTokens: 509_697 });
  const c = ctx(await fire('god-1', 'SessionStart', { source: 'startup' }));
  assert.match(c, /<god-handoff>/);
  assert.match(c, new RegExp(`instead of resuming your previous session ${SID} \\(its last request carried 510K tokens\\), because: context-over-limit, cache-expired`));
  assert.match(c, /Never read tasks\.json whole\./);
  assert.doesNotMatch(c, /an old note that is NOT a standing lesson/);
  assert.match(c, /floor-digest\.md:\n# Floor digest/);
  assert.match(c, /board-status\.md:\n# Board status/);
  assert.match(c, /LIVE ROSTER|<\/god-handoff>/);
  assert.doesNotMatch(ctx(await fire('god-1', 'SessionStart', { source: 'startup' })), /<god-handoff>/, 'delivered once');
  const rows = hive.logTail(200).map((r) => r.kind);
  assert.ok(rows.includes('god-handoff-armed') && rows.includes('god-handoff-delivered'));
});

test('R1 HANDOFF: never on another event, a compact/resume SessionStart, a one-way hook, or another agent', async (t) => {
  const { hive, fire } = await floor(t);
  hive.armGodHandoff('god-1', { reasons: ['cache-expired'], previousSession: SID, contextTokens: null });
  assert.doesNotMatch(ctx(await fire('god-1', 'UserPromptSubmit', { prompt: 'hello' })), /<god-handoff>/);
  assert.doesNotMatch(ctx(await fire('god-1', 'SessionStart', { source: 'compact' })), /<god-handoff>/);
  assert.doesNotMatch(ctx(await fire('god-1', 'SessionStart', { source: 'resume' })), /<god-handoff>/);
  assert.doesNotMatch(ctx(await fire('god-1', 'SessionStart', { source: 'startup', transport: 'pipe-oneway' })), /<god-handoff>/);
  hive.armGodHandoff('jim-1', { reasons: ['cache-expired'], previousSession: SID, contextTokens: null });
  assert.doesNotMatch(ctx(await fire('jim-1', 'SessionStart', { source: 'startup' })), /<god-handoff>/, 'god only');
  assert.match(ctx(await fire('god-1', 'SessionStart', { source: 'startup' })), /<god-handoff>/, 'still armed for its real start');
});

test('R1 HANDOFF does not lose pending mail: it rides SessionStart, where no mail is surfaced; the mail comes on the first prompt', async (t) => {
  const { hive, fire } = await floor(t);
  const m = hive.send({ to: 'god-1', act: 'request', subject: 'pending', body: 'please handle' }, 'jim-1');
  hive.armGodHandoff('god-1', { reasons: ['context-over-limit'], previousSession: SID, contextTokens: 300_000 });
  const start = ctx(await fire('god-1', 'SessionStart', { source: 'startup' }));
  assert.match(start, /<god-handoff>/);
  assert.doesNotMatch(start, /hive-mail:/);
  assert.equal(hive.mail.ledger('god-1').entries[m.id].state, 'delivered', 'still pending after the handoff');
  const prompt = ctx(await fire('god-1', 'UserPromptSubmit', { prompt: 'orient' }));
  assert.match(prompt, new RegExp(`\\[hive-mail:${m.id}\\]`), 'the first prompt surfaces it');
});

test('R1 HANDOFF is bounded: long files are cut with a pointer, and the whole block stays under GOD_HANDOFF_MAX', () => {
  const huge = 'y'.repeat(50_000);
  const text = G.godHandoffContext({ reasons: ['context-over-limit'], previousSession: SID, contextTokens: 1, memory: `## How I work (standing lessons)\n${huge}`, floorDigest: huge, boardStatus: huge });
  assert.ok(text.length <= G.GOD_HANDOFF_MAX, `${text.length}`);
  assert.match(text, /cut at 3000 characters; read the file for the rest/);
  assert.ok(text.endsWith('</god-handoff>'));
  assert.equal(G.standingLessons('# x\n## Other\n- y'), '');
  // The overall cap is the backstop for whatever the per-piece bounds miss (here, a long reason list).
  const capped = G.godHandoffContext({ reasons: Array.from({ length: 2_000 }, (_, i) => `reason-${i}`), previousSession: SID, contextTokens: 1, memory: null, floorDigest: huge, boardStatus: huge });
  assert.ok(capped.length <= G.GOD_HANDOFF_MAX, `${capped.length}`);
  assert.ok(capped.endsWith('</god-handoff>'));
});

// ─── R2: the orientation prompt ─────────────────────────────────────────────

test('R2: the fresh god\'s orientation reads the digest and the board status, and the raw board only for a named card', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/hooks/useHive.ts'), 'utf8');
  const prompt = src.slice(src.indexOf('const INITIAL_GOD_PROMPT = ['), src.indexOf("].join('\\n');", src.indexOf('const INITIAL_GOD_PROMPT = [')));
  assert.match(prompt, /'2\. Read floor-digest\.md and board-status\.md \(hive root\) and the current roster of agents \(active vs archived\)\. Open board\.md or tasks\.json only for a named card, with grep or jq; never read them whole\.'/);
  assert.doesNotMatch(prompt, /Review board\.md \+ tasks\.json/);
});

// ─── R3: billed-equivalent tokens ───────────────────────────────────────────

test('R3: billed-equivalent = input + output + 0.1 x cache read + 1.25 x cache write (2 x for a known 1-hour write); raw kept', () => {
  // The 1.1.77 fresh start measured in the diagnosis: 997,845 read, 58,000 write, ~8,000 out, 28 in.
  const start = { input: 28, output: 8_000, cacheRead: 997_845, cacheCreation: 58_000 };
  assert.equal(TW.rawTokens(start), 1_063_873);
  assert.equal(TW.billedEquivalentTokens(start), 28 + 8_000 + 99_785 + 72_500);
  assert.equal(TW.billedEquivalentTokens({ ...start, cacheCreation1h: 58_000 }), 28 + 8_000 + 99_785 + 116_000);
  assert.equal(TW.billedEquivalentTokens({ ...start, cacheCreation1h: 10_000 }), 28 + 8_000 + 99_785 + 60_000 + 20_000);
  assert.equal(TW.billedEquivalentTokens(null), 0);
  assert.equal(TW.billedEquivalentTokens({ input: -5, output: NaN, cacheRead: 10, cacheCreation: 0 }), 1);
  assert.match(TW.tokenFigureTitle(start), /^180,313 billed-equivalent tokens \(cache reads x0\.1, cache writes x1\.25\)\. Raw: 1,063,873 \(cache read 997,845, cache write 58,000\); the token caps count raw\.$/);
});

test('R3 wiring: fleet.json tokens is billed-equivalent with tokensRaw beside it; the card shows it with the raw in its tooltip; caps stay raw', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(index, /const tokens = billedEquivalentTokens\(u\);\s+const tokensRaw = rawTokens\(u\);/);
  assert.match(index, /breaker: breaker\.levelFor\(id\),\s+tokens,\s+tokensRaw,/);
  assert.match(index, /function workerTokensUsed[\s\S]{0,200}return s \? s\.input \+ s\.output \+ s\.cacheRead \+ s\.cacheCreation : 0;/, 'the per-worker cap counts raw');
  const card = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/CommandCenterPanel.tsx'), 'utf8');
  assert.match(card, /data-testid="agent-token-figure"\s+title=\{tokenFigureTitle\(sample\)\}[\s\S]{0,200}>\{fmtTokens\(billedEquivalentTokens\(sample\)\)\}<\/span>/);
  assert.match(card, /const tokens = sample \? sample\.input \+ sample\.output \+ sample\.cacheRead \+ sample\.cacheCreation : 0;/, 'the bar against the cap stays raw');
  const breakerSrc = fs.readFileSync(path.join(__dirname, '..', 'src/main/breaker.ts'), 'utf8');
  assert.match(breakerSrc, /s \? s\.input \+ s\.output \+ s\.cacheRead \+ s\.cacheCreation : 0;/, 'the breaker counts raw');
});
