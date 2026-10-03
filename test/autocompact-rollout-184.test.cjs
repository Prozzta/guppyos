'use strict';

/**
 * READS-AUTOCOMPACT-ROLLOUT (1.1.84): the auto-compact window god piloted in 1.1.81 becomes the
 * default for EVERY Claude agent (150k), with the per-agent override and the off switches kept.
 *
 * The god pilot passed (Creed's after-run: re-read per request -60%, cost per request -52%), while
 * workers without it were compacted by hand at 434-629k. Codex agents keep their own limit
 * (codexAutoCompactTokenLimit, 120k): only a Claude spawn sets CLAUDE_CODE_AUTO_COMPACT_WINDOW
 * (test/autocompact-pilot-181 pins that), and compact-health gives a window only to a Claude agent.
 *
 * Mutants that must die: MUTANT CENSUS at the bottom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');

const A = loadTs('src/shared/autoCompactWindow.ts');
const CH = loadTs('src/main/compactHealth.ts');
const K = {};

// ─── who gets which window ──────────────────────────────────────────────────────────────────

K.resolve = (M = A) => {
  const W = { isGod: false };
  const G = { isGod: true };
  assert.equal(M.AUTO_COMPACT_WINDOW_DEFAULT, 150000);
  assert.equal(M.autoCompactWindowFor(W, {}), 150000, 'EVERY CLAUDE WORKER GETS 150K BY DEFAULT');
  assert.equal(M.autoCompactWindowFor(W, null), 150000, 'no config at all: still the default');
  assert.equal(M.autoCompactWindowFor(W, { claudeAutoCompactWindow: 180000 }), 180000, 'THE FLOOR SETTING SETS IT');
  assert.equal(M.autoCompactWindowFor(W, { claudeAutoCompactWindow: 'off' }), null, 'THE FLOOR OFF SWITCH');
  assert.equal(M.autoCompactWindowFor(W, { claudeAutoCompactWindow: 'big' }), 150000, 'a bad floor value falls back to the default');
  assert.equal(M.autoCompactWindowFor(W, { godAutoCompactWindow: 'off' }), 150000, 'GOD\'S SWITCH DOES NOT TOUCH WORKERS');
  // the per-agent override still wins, both ways
  assert.equal(M.autoCompactWindowFor({ isGod: false, autoCompactWindow: 120000 }, { claudeAutoCompactWindow: 'off' }), 120000, 'AN AGENT\'S OWN VALUE BEATS THE FLOOR OFF');
  assert.equal(M.autoCompactWindowFor({ isGod: false, autoCompactWindow: 'off' }, { claudeAutoCompactWindow: 180000 }), null, 'AN AGENT\'S OWN OFF BEATS THE FLOOR');
  // god: the pilot's own setting first, then the floor
  assert.equal(M.autoCompactWindowFor(G, { claudeAutoCompactWindow: 180000 }), 180000, 'god follows the floor when its own setting is unset');
  assert.equal(M.autoCompactWindowFor(G, { godAutoCompactWindow: 200000, claudeAutoCompactWindow: 180000 }), 200000, 'GOD\'S SETTING BEATS THE FLOOR');
  assert.equal(M.autoCompactWindowFor(G, { godAutoCompactWindow: 'off', claudeAutoCompactWindow: 180000 }), null, 'god\'s off still switches god off');
  assert.equal(M.autoCompactWindowFor(G, { godAutoCompactWindow: 150000, claudeAutoCompactWindow: 'off' }), 150000, 'god kept on while the floor is off');
  assert.equal(M.autoCompactWindowFor(G, { claudeAutoCompactWindow: 'off' }), null, 'the floor off reaches god when god has no setting');
  // an unknown agent (no registry record) gets nothing
  assert.equal(M.autoCompactWindowFor(null, {}), null, 'AN UNKNOWN AGENT GETS NO WINDOW');
  assert.equal(M.autoCompactWindowFor(undefined, { claudeAutoCompactWindow: 180000 }), null);
};
test('resolution: every Claude agent 150k by default; own value, god\'s setting, the floor setting and the off switches still decide', () => K.resolve());

K.ignored = (M = A) => {
  assert.deepEqual(M.autoCompactWindowIgnored({ isGod: false }, { claudeAutoCompactWindow: 'big' }), [{ setting: 'claudeAutoCompactWindow', value: 'big' }]);
  assert.deepEqual(M.autoCompactWindowIgnored({ isGod: false, autoCompactWindow: 120000 }, { claudeAutoCompactWindow: 'big' }), [], 'A VALID OWN VALUE MAKES THE FLOOR MOOT');
  assert.deepEqual(M.autoCompactWindowIgnored({ isGod: true, autoCompactWindow: 120000 }, { godAutoCompactWindow: 'big', claudeAutoCompactWindow: 'big' }), []);
  assert.deepEqual(M.autoCompactWindowIgnored({ isGod: true }, { godAutoCompactWindow: 200000, claudeAutoCompactWindow: 'big' }), [], 'god\'s valid setting makes the floor moot for god');
  assert.deepEqual(M.autoCompactWindowIgnored({ isGod: true }, { godAutoCompactWindow: 'big', claudeAutoCompactWindow: 'off' }), [{ setting: 'godAutoCompactWindow', value: 'big' }], 'a bad god setting is named; the floor then decides');
  assert.deepEqual(M.autoCompactWindowIgnored({ isGod: false, autoCompactWindow: 5 }, { claudeAutoCompactWindow: 'big' }), [{ setting: 'autoCompactWindow', value: '5' }, { setting: 'claudeAutoCompactWindow', value: 'big' }], 'every bad one in the path');
  assert.deepEqual(M.autoCompactWindowIgnored({ isGod: false }, { godAutoCompactWindow: 'big' }), [], 'god\'s setting is not a worker\'s');
  assert.deepEqual(M.autoCompactWindowIgnored(null, { claudeAutoCompactWindow: 'big' }), []);
};
test('n1 kept: a set-but-invalid setting is named only when it is on this agent\'s path and nothing valid decided first', () => K.ignored());

// ─── compact-health covers every agent ──────────────────────────────────────────────────────

const boundary = (uuid, pre, post, ts) => JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid, timestamp: ts, isSidechain: false, compactMetadata: { trigger: 'auto', preTokens: pre, postTokens: post, durationMs: 18000 } });
const req = (read, write, out) => JSON.stringify({ type: 'assistant', isSidechain: false, message: { usage: { input_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: out } } });
K.everyAgent = (M = CH) => {
  const tail = [req(100000, 2000, 50), boundary('w1', 117000, 8000, '2026-10-03T18:00:00.200Z'), req(7000, 6000, 40)].join('\n');
  const windows = { 'jim-1': 150000, 'god': 200000, 'dwight-1': null };
  const rows = [];
  const w = new M.CompactHealthWatch({ log: (r) => rows.push(r), readTail: () => tail, windowOf: (a) => windows[a], now: () => Date.parse('2026-10-03T18:00:00Z') });
  for (const a of Object.keys(windows)) { w.noteCompact(a, `C:/${a}.jsonl`); w.onStop(a); }
  assert.deepEqual(rows.map((r) => [r.agentId, r.window]), [['jim-1', 150000], ['god', 200000], ['dwight-1', null]], 'A ROW FOR EVERY AGENT, EACH WITH ITS OWN WINDOW');
  assert.ok(rows.every((r) => r.kind === 'compact-health' && r.preTokens === 117000 && r.n === 1));
};
test('compact-health: a row for every agent\'s compaction, worker or god, each with the window its spawn got', () => K.everyAgent());

K.wiring = (idx = readSource('src/main/index.ts')) => {
  const at = idx.indexOf('hookServer.setCompactHealth(new CompactHealthWatch({');
  assert.ok(at > 0);
  const w = idx.slice(at, at + 900);
  assert.match(w, /windowOf: \(agentId\) => \{\n    const a = hive\.registry\(\)\.agents\[agentId\];\n    if \(!a \|\| !isClaudeProvider\(a\.provider \?\? 'claude'\)\) return null;/, 'ONLY A CLAUDE AGENT HAS A WINDOW IN ITS ROWS');
  assert.match(w, /return autoCompactWindowFor\(\{ isGod: hive\.isGod\(agentId\), autoCompactWindow: a\.autoCompactWindow \}, readConfig\(\)\);/, 'the rows use the same resolution as the spawn');
  // The spawn: one resolution for every Claude agent, with the whole config (so claudeAutoCompactWindow reaches it).
  const claude = idx.slice(idx.indexOf('  if (opts.hive && claudeProvider) {'), idx.indexOf('  if (opts.hive && !claudeProvider) {'));
  assert.match(claude, /const compactWindow = autoCompactWindowFor\(compactAgent, cfg\);/);
  assert.ok(!/isGod[^\n]*\?[^\n]*autoCompactWindowFor|if \(opts\.hive\.isGod\)[^\n]*compactWindow/.test(claude), 'NO GOD-ONLY GATE AROUND THE SPAWN WINDOW');
  const cfgType = readSource('src/main/config.ts');
  assert.match(cfgType, /claudeAutoCompactWindow\?: number \| 'off';/, 'the floor setting is a typed config key');
};
test('wiring: compact-health windows only for Claude agents; the spawn resolves every Claude agent the same way', () => K.wiring());

// ─── MUTANT CENSUS ──────────────────────────────────────────────────────────────────────────

function mutateText(rel, edits, tag) {
  let text = readSource(rel);
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  return text;
}
const SH = 'src/shared/autoCompactWindow.ts';
const MUTANTS = [
  { name: 'workers keep Claude\'s own "auto" (the pilot)', file: SH, module: true,
    edits: [['  const floor = normalizeAutoCompactWindow(cfg?.claudeAutoCompactWindow);', "  if (agent.isGod !== true) return null;\n  const floor = normalizeAutoCompactWindow(cfg?.claudeAutoCompactWindow);"]], killer: 'resolve', dies: /EVERY CLAUDE WORKER GETS 150K BY DEFAULT/ },
  { name: 'the floor setting is never read', file: SH, module: true,
    edits: [['  const floor = normalizeAutoCompactWindow(cfg?.claudeAutoCompactWindow);', '  const floor = undefined as AutoCompactSetting | undefined;']], killer: 'resolve', dies: /THE FLOOR SETTING SETS IT/ },
  { name: 'the floor off switch is ignored', file: SH, module: true,
    edits: [["  if (floor === 'off') return null;\n", '']], killer: 'resolve', dies: /THE FLOOR OFF SWITCH/ },
  { name: 'god\'s setting applies to everyone', file: SH, module: true,
    edits: [['  if (agent.isGod === true) {\n    const god', '  if (true) {\n    const god']], killer: 'resolve', dies: /GOD'S SWITCH DOES NOT TOUCH WORKERS/ },
  { name: 'the floor beats god\'s own setting', file: SH, module: true,
    edits: [["    if (god !== undefined) return god === 'off' ? null : god;", "    if (god !== undefined && cfg?.claudeAutoCompactWindow === undefined) return god === 'off' ? null : god;"]], killer: 'resolve', dies: /GOD'S SETTING BEATS THE FLOOR/ },
  { name: 'the agent\'s own value no longer wins', file: SH, module: true,
    edits: [["  if (own !== undefined) return own === 'off' ? null : own;\n  if (agent.isGod === true) {", '  if (agent.isGod === true) {']], killer: 'resolve', dies: /AN AGENT'S OWN VALUE BEATS THE FLOOR OFF/ },
  { name: 'an unknown agent gets the default', file: SH, module: true,
    edits: [['  if (!agent) return null;\n  const own = normalizeAutoCompactWindow(agent.autoCompactWindow);', '  const own = normalizeAutoCompactWindow(agent?.autoCompactWindow);'],
      ['  if (agent.isGod === true) {\n    const god', '  if (agent?.isGod === true) {\n    const god']], killer: 'resolve', dies: /AN UNKNOWN AGENT GETS NO WINDOW/ },
  { name: 'n1: a moot setting is reported', file: SH, module: true,
    edits: [['    if (normalizeAutoCompactWindow(v) !== undefined) break;', '    if (normalizeAutoCompactWindow(v) !== undefined) continue;']], killer: 'ignored', dies: /A VALID OWN VALUE MAKES THE FLOOR MOOT/ },
  { name: 'compact-health is god-only', file: 'src/main/compactHealth.ts', module: true, deps: true,
    edits: [['  noteCompact(agentId: string, transcriptPath: string | null | undefined): void {\n', "  noteCompact(agentId: string, transcriptPath: string | null | undefined): void {\n    if (agentId !== 'god') return;\n"]], killer: 'everyAgent', dies: /A ROW FOR EVERY AGENT, EACH WITH ITS OWN WINDOW/ },
  { name: 'a Codex agent gets a Claude window in its rows', file: 'src/main/index.ts',
    edits: [["    if (!a || !isClaudeProvider(a.provider ?? 'claude')) return null;\n", '    if (!a) return null;\n']], killer: 'wiring', dies: /ONLY A CLAUDE AGENT HAS A WINDOW IN ITS ROWS/ },
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, () => {
      const text = mutateText(m.file, m.edits, m.name);
      const run = m.module ? () => K[m.killer](loadTs.fromText(m.file, text)) : () => K[m.killer](text);
      assert.throws(run, (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      });
    });
  }
});
