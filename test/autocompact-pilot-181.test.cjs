'use strict';

/**
 * READS-ROTATE-AT-SIZE pilot (1.1.81): Claude Code's own auto-compact window, god-only at 150k.
 *
 * Probed on Claude Code 2.1.288 (t12/probe181/probe-compact.cjs, Haiku, CLAUDE_CODE_AUTO_COMPACT_WINDOW
 * = 100000): Claude compacted by itself three times inside one turn, each at ~75k, with
 * PreCompact(auto), SessionStart(compact), PostCompact(auto) and compact_boundary trigger "auto".
 * The app: passes the window as an env var at spawn (the injected prompt is unchanged), logs a
 * `compact-health` row per compaction, and re-injects open mail at SessionStart(compact) (11.5).
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
  assert.equal(M.autoCompactWindowFor({ isGod: true }, {}), 150000, 'GOD GETS 150K BY DEFAULT');
  assert.equal(M.autoCompactWindowFor({ isGod: false }, {}), null, 'WORKERS KEEP CLAUDE\'S OWN "AUTO"');
  assert.equal(M.autoCompactWindowFor({}, { godAutoCompactWindow: 200000 }), null, 'the god setting is for god only');
  assert.equal(M.autoCompactWindowFor({ isGod: true }, { godAutoCompactWindow: 'off' }), null, 'THE OFF SWITCH');
  assert.equal(M.autoCompactWindowFor({ isGod: true }, { godAutoCompactWindow: 180000 }), 180000);
  assert.equal(M.autoCompactWindowFor({ isGod: false, autoCompactWindow: 120000 }, {}), 120000, 'an agent\'s own window wins (workers, later)');
  assert.equal(M.autoCompactWindowFor({ isGod: true, autoCompactWindow: 'off' }, {}), null, 'AN AGENT\'S OWN "OFF" WINS');
  for (const bad of [50000, 2_000_000, 'x', NaN, Infinity, '150000']) {
    assert.equal(M.autoCompactWindowFor({ isGod: true, autoCompactWindow: bad }, {}), 150000, `A BAD VALUE NEVER REACHES CLAUDE: ${String(bad)}`);
  }
  assert.equal(M.normalizeAutoCompactWindow(150000.4), 150000);
  assert.equal(M.AUTO_COMPACT_WINDOW_ENV, 'CLAUDE_CODE_AUTO_COMPACT_WINDOW');
};
test('resolution: god 150k by default, workers unchanged, own value or "off" wins, bad values ignored', () => K.resolve());

// ─── reading compactions from the transcript ────────────────────────────────────────────────

const boundary = (uuid, pre, post, ts) => JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid, timestamp: ts, isSidechain: false, compactMetadata: { trigger: 'auto', preTokens: pre, postTokens: post, durationMs: 18000 } });
const req = (read, write, out, side = false) => JSON.stringify({ type: 'assistant', isSidechain: side, message: { usage: { input_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: out } } });
const TAIL = [
  req(70000, 2000, 50),
  boundary('b1', 73847, 15666, '2026-10-03T07:06:39Z'),
  JSON.stringify({ type: 'user', isCompactSummary: true, message: { content: 'summary' } }),
  req(1, 1, 1, true),                 // a sidechain request is not the agent's
  req(32935, 28031, 188),
  req(61000, 900, 30),
  boundary('b2', 74679, 16089, '2026-10-03T07:07:15Z'),
  boundary('b3', 75087, 16640, '2026-10-03T07:07:48Z'),
  req(32935, 29365, 1874)
].join('\n');

K.parse = (M = A) => {
  const all = M.compactHealthsFromTail(TAIL);
  assert.deepEqual(all.map((h) => h.uuid), ['b1', 'b2', 'b3'], 'EVERY COMPACTION, OLDEST FIRST');
  assert.deepEqual([all[0].trigger, all[0].preTokens, all[0].postTokens, all[0].durationMs], ['auto', 73847, 15666, 18000]);
  assert.deepEqual(all[0].first, { context: 60976, input: 10, cacheRead: 32935, cacheWrite: 28031, output: 188, billedEquivalent: 59554 }, 'the first NON-sidechain request after it, priced read x0.1, write x2');
  assert.equal(all[1].first, null, 'B2\'S FIRST REQUEST IS NOT ONE AFTER A LATER BOUNDARY');
  assert.equal(all[2].first.context, 62310);
  assert.equal(M.compactHealthFromTail(TAIL).uuid, 'b3');
  assert.equal(M.compactHealthFromTail(req(1, 1, 1)), null);
  assert.deepEqual(M.compactHealthsFromTail('{torn'), []);
};
test('the transcript: every compact_boundary, each with the first request after it', () => K.parse());

// ─── the watcher ────────────────────────────────────────────────────────────────────────────

function watch(M = CH, tails, now = Date.parse('2026-10-03T07:06:00Z')) {
  const rows = []; let n = 0; let clock = now;
  const w = new M.CompactHealthWatch({ log: (r) => rows.push(r), readTail: () => tails[Math.min(n++, tails.length - 1)], windowOf: () => 150000, now: () => clock });
  return { w, rows, setNow: (t) => { clock = t; } };
}

K.noRelogAfterRestart = (M = CH) => {
  // After an app restart the in-memory set is empty; the first compaction then reads a tail that
  // still holds b1..b3 from before the restart. Only the boundary written since its
  // SessionStart(compact) may be logged.
  const restartTail = [TAIL, boundary('b4', 150000, 18000, '2026-10-03T09:00:00.250Z'), req(30000, 25000, 40)].join('\n');
  const x = watch(M, [restartTail], Date.parse('2026-10-03T09:00:00Z'));
  x.w.noteCompact('god', 'C:/t.jsonl');
  x.w.onStop('god');
  assert.deepEqual(x.rows.map((r) => r.preTokens), [150000], 'AN OLDER BOUNDARY IS NOT LOGGED AGAIN AFTER A RESTART');
  // Several compactions in one turn: the FIRST SessionStart(compact) sets the time.
  const y = watch(M, [TAIL], Date.parse('2026-10-03T07:06:39Z'));
  y.w.noteCompact('god', 'C:/t.jsonl');
  y.setNow(Date.parse('2026-10-03T07:07:48Z'));
  y.w.noteCompact('god', 'C:/t.jsonl');
  y.w.onStop('god');
  assert.equal(y.rows.length, 3, 'every compaction of THIS turn still counts');
};
test('n2: after an app restart, boundaries older than the arming SessionStart(compact) are not logged again', () => K.noRelogAfterRestart());

test('n1: a set-but-invalid window is reported, only where it applies', () => {
  assert.deepEqual(A.autoCompactWindowIgnored({ isGod: true }, { godAutoCompactWindow: 'big' }), [{ setting: 'godAutoCompactWindow', value: 'big' }]);
  assert.deepEqual(A.autoCompactWindowIgnored({ isGod: true, autoCompactWindow: 5 }, {}), [{ setting: 'autoCompactWindow', value: '5' }]);
  assert.deepEqual(A.autoCompactWindowIgnored({ isGod: true, autoCompactWindow: 120000 }, { godAutoCompactWindow: 'big' }), [], 'a valid own value makes the god setting moot');
  assert.deepEqual(A.autoCompactWindowIgnored({ isGod: false }, { godAutoCompactWindow: 'big' }), [], 'the god setting does not apply to a worker');
  assert.deepEqual(A.autoCompactWindowIgnored({ isGod: true }, { godAutoCompactWindow: 'off' }), []);
  assert.deepEqual(A.autoCompactWindowIgnored({ isGod: true }, {}), []);
  const idx = readSource('src/main/index.ts');
  assert.match(idx, /if \(compactIgnored\.length\) hive\.appendLog\(\{ kind: 'auto-compact-window-ignored', agentId: opts\.hive\.id, ignored: compactIgnored, using: compactWindow \}\);/);
});

K.watchLogsAll = (M = CH) => {
  const x = watch(M, [TAIL]);
  x.w.onStop('god');
  assert.deepEqual(x.rows, [], 'nothing without a SessionStart(compact)');
  x.w.noteCompact('god', 'C:/t.jsonl');
  x.w.onStop('god');
  assert.deepEqual(x.rows.map((r) => r.preTokens), [73847, 74679, 75087], 'ONE ROW PER COMPACTION, ALL OF THEM');
  assert.deepEqual(Object.keys(x.rows[0]).sort(), ['agentId', 'at', 'durationMs', 'firstRequest', 'kind', 'postTokens', 'preTokens', 'trigger', 'window']);
  assert.equal(x.rows[0].kind, 'compact-health');
  assert.equal(x.rows[0].window, 150000);
  x.w.noteCompact('god', 'C:/t.jsonl');
  x.w.onStop('god');
  assert.equal(x.rows.length, 3, 'EACH BOUNDARY IS LOGGED ONCE');
};
test('watcher: a SessionStart(compact) then a Stop logs every new compaction once, with the window', () => K.watchLogsAll());

test('watcher: the last boundary without its first request is retried, then logged anyway at the 3rd Stop', () => {
  const pending = [boundary('c1', 140000, 20000, 't')].join('\n');
  const x = watch(CH, [pending, pending, pending]);
  x.w.noteCompact('god', 'C:/t.jsonl');
  x.w.onStop('god'); x.w.onStop('god');
  assert.equal(x.rows.length, 0);
  x.w.onStop('god');
  assert.equal(x.rows.length, 1);
  assert.equal(x.rows[0].firstRequest, null);
  const y = watch(CH, [null]);
  y.w.noteCompact('god', 'C:/missing.jsonl'); y.w.onStop('god'); y.w.onStop('god'); y.w.onStop('god'); y.w.onStop('god');
  assert.equal(y.rows.length, 0, 'an unreadable transcript logs nothing and stops trying');
  const z = watch(CH, [TAIL]);
  z.w.noteCompact('god', null);
  z.w.onStop('god');
  assert.equal(z.rows.length, 0, 'no transcript path: nothing to read');
});

// ─── the wiring ─────────────────────────────────────────────────────────────────────────────

K.wiring = (idx = readSource('src/main/index.ts'), hooks = readSource('src/main/hooks.ts')) => {
  const claude = idx.slice(idx.indexOf('  if (opts.hive && claudeProvider) {'), idx.indexOf('  if (opts.hive && !claudeProvider) {'));
  assert.match(claude, /const compactAgent = \{ isGod: opts\.hive\.isGod, autoCompactWindow: hive\.registry\(\)\.agents\[opts\.hive\.id\]\?\.autoCompactWindow \};\n    const compactWindow = autoCompactWindowFor\(compactAgent, cfg\);/);
  assert.match(claude, /if \(compactWindow !== null\) \{\n      opts\.env = \{ \.\.\.\(opts\.env \?\? \{\}\), \[AUTO_COMPACT_WINDOW_ENV\]: String\(compactWindow\) \};/, 'THE WINDOW REACHES A CLAUDE SPAWN AS AN ENV VAR');
  assert.ok(!/AUTO_COMPACT_WINDOW_ENV|compactWindow/.test(idx.slice(idx.indexOf('  if (opts.hive && !claudeProvider) {'), idx.indexOf('  if (opts.hive && !claudeProvider) {') + 4000)), 'never for another CLI');
  assert.match(idx, /hookServer\.setCompactHealth\(new CompactHealthWatch\(\{/);
  const handle = hooks.slice(hooks.indexOf('  private handle(p: HookPayload): unknown {'));
  const at = handle.indexOf('if (event === \'SessionStart\' && p.source === \'compact\') this.compactHealth.noteCompact(agentId, p.transcript_path ?? this.transcriptPaths.get(agentId));');
  assert.ok(at > 0, 'SESSIONSTART(COMPACT) IS NOTED');
  // (The only return above it is AGY's status-line telemetry, which is not a hook boundary.)
  assert.ok(at < handle.indexOf('return {'), 'before every early return of handle()');
  assert.match(handle, /else if \(event === 'Stop'\) this\.compactHealth\.onStop\(agentId\);/, 'AND THE STOP LOGS IT');
};
test('wiring: the env var on Claude spawns only; the watcher on SessionStart(compact) and Stop, before any early return', () => K.wiring());

test('open mail is re-injected after a compaction (ZT-I1-MAIL 11.5), and the prompt fingerprint ignores the env', () => {
  const hooks = readSource('src/main/hooks.ts');
  assert.match(hooks, /if \(injecting && agentId && !fromSubagent && event === 'SessionStart' && p\.source === 'compact' && p\.transport !== 'pipe-oneway'\) \{\n      try \{ mailBlock = this\.reinjectMail\(agentId, p, channel\?\.provider, \[handoff, roster, goal, steer, mail\]\); \}/);
  // The window is an env var only: the session-prompt fingerprint reads the injected prompt text,
  // never opts.env (test/session-prompt-rotation pins the fingerprints themselves).
  const hive = readSource('src/main/hive.ts');
  const fp = hive.slice(hive.indexOf('  sessionPromptFingerprint('), hive.indexOf('  sessionPromptFingerprint(') + 3000);
  assert.ok(fp.length > 100 && !/autoCompact|AUTO_COMPACT|\.env\b/.test(fp));
});

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
  { name: 'god gets no default window', file: SH, module: true,
    edits: [['  return god ?? GOD_AUTO_COMPACT_WINDOW_DEFAULT;', '  return god ?? null;']], killer: 'resolve', dies: /GOD GETS 150K BY DEFAULT/ },
  { name: 'every agent gets the god default', file: SH, module: true,
    edits: [['  if (agent?.isGod !== true) return null;\n', '']], killer: 'resolve', dies: /WORKERS KEEP CLAUDE'S OWN "AUTO"/ },
  { name: 'the config off switch is ignored', file: SH, module: true,
    edits: [["  if (god === 'off') return null;\n", '']], killer: 'resolve', dies: /THE OFF SWITCH/ },
  { name: 'the range check is gone', file: SH, module: true,
    edits: [['  return n >= AUTO_COMPACT_WINDOW_MIN && n <= AUTO_COMPACT_WINDOW_MAX ? n : undefined;', '  return n;']], killer: 'resolve', dies: /A BAD VALUE NEVER REACHES CLAUDE/ },
  { name: 'a first request is taken from after a later boundary', file: SH, module: true,
    edits: [["    if (lines[i].includes('\"compact_boundary\"')) break;\n", '']], killer: 'parse', dies: /B2'S FIRST REQUEST IS NOT ONE AFTER A LATER BOUNDARY/ },
  { name: 'only the last compaction is logged', file: 'src/main/compactHealth.ts', module: true, deps: true,
    edits: [['    for (const h of all) {', '    for (const h of all.slice(-1)) {']], killer: 'watchLogsAll', dies: /ONE ROW PER COMPACTION, ALL OF THEM/ },
  { name: 'a boundary is logged again', file: 'src/main/compactHealth.ts', module: true, deps: true,
    edits: [['      if (seen.has(h.uuid)) continue;\n', '']], killer: 'watchLogsAll', dies: /EACH BOUNDARY IS LOGGED ONCE/ },
  { name: 'n2 off: older boundaries are logged again after a restart', file: 'src/main/compactHealth.ts', module: true, deps: true,
    edits: [['      if (Number.isFinite(t) ? t < p.since - COMPACT_SKEW_MS : h !== last) continue;\n', '']], killer: 'noRelogAfterRestart', dies: /AN OLDER BOUNDARY IS NOT LOGGED AGAIN AFTER A RESTART/ },
  { name: 'n2: each SessionStart(compact) resets the time (a turn loses its earlier boundaries)', file: 'src/main/compactHealth.ts', module: true, deps: true,
    edits: [['    const since = this.pending.get(agentId)?.since ?? (this.d.now ?? Date.now)();', '    const since = (this.d.now ?? Date.now)();']], killer: 'noRelogAfterRestart', dies: /every compaction of THIS turn still counts/ },
  { name: 'the env var is never set', file: 'src/main/index.ts',
    edits: [['      opts.env = { ...(opts.env ?? {}), [AUTO_COMPACT_WINDOW_ENV]: String(compactWindow) };\n', '']], killer: 'wiring', dies: /THE WINDOW REACHES A CLAUDE SPAWN AS AN ENV VAR/ },
  { name: 'the Stop never logs', file: 'src/main/hooks.ts', hooks: true,
    edits: [["        else if (event === 'Stop') this.compactHealth.onStop(agentId);\n", '']], killer: 'wiring', dies: /AND THE STOP LOGS IT/ }
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, () => {
      const text = mutateText(m.file, m.edits, m.name);
      const run = m.module ? () => K[m.killer](loadTs.fromText(m.file, text))
        : m.hooks ? () => K[m.killer](undefined, text)
        : () => K[m.killer](text);
      assert.throws(run, (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      });
    });
  }
});
