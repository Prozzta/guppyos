'use strict';

/**
 * BOOT-ORPHAN-ASSIGNEE-DOWN + BOARDMONITOR-DOUBLE-RAISE (1.1.78; Dwight 644297f2 + 3c4fc538,
 * finished by Creed for god plan-178 1a1ee0).
 *
 * The boot sweep archives every worker as 'orphan' before autostart respawns them, so each
 * packaged start raised ASSIGNEE_DOWN noise. Dwight's fix gives an orphan archive a bounded,
 * TIMESTAMPED grace (BOARD_STALE_DEFAULTS.bootGraceMs). This file pins Creed's audit must-fix M1
 * (an orphan that never comes back must still be flagged, and escalate) and the fail-safe for
 * missing timestamps, and turns the header-only mutant lists into an executed census.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');

const ROOT = path.resolve(__dirname, '..');
const STALE = loadTs('src/shared/boardStale.ts');
const MONITOR = loadTs('src/main/boardMonitor.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const H = 3_600_000;
const NOW = 100 * H;
const doing = (id, assignee) => ({ id, title: id, status: 'doing', assignee });
const lv = (agentId, classification, since, extra = {}) => ({ agentId, incarnation: `${agentId}-1`, lifecycle: 'LIVE', classification,
  classifiedSince: since, reason: 'none', evidence: { sampledAt: NOW }, ...extra });

function run(S, { registry = {}, liveness = {} }) {
  const tasks = [doing('A', 'jim')];
  return S.detectStale({ tasks, meta: { A: { statusSince: 0, lastEditAt: 0 } }, registry: new Map(Object.entries(registry)),
    liveness: new Map(Object.entries(liveness)), fleet: new Map(), now: NOW })
    .map((f) => `${f.cardId}:${f.kind}${f.decision ? '!' : ''}`);
}

const K = {};

K.orphanNeverBackFlagged = (S = STALE) => {
  const D = S.BOARD_STALE_DEFAULTS;
  assert.equal(D.bootGraceMs, 5 * 60_000, 'the boot grace is 5 minutes');
  const reg = (age) => run(S, { registry: { jim: { archived: true, archiveReason: 'orphan', lastSeen: NOW - age } } });
  assert.deepEqual(reg(D.bootGraceMs - 1), [], 'quiet inside the boot grace');
  assert.deepEqual(reg(D.bootGraceMs), ['A:ASSIGNEE_DOWN'], 'M1: AN ORPHAN THAT NEVER COMES BACK IS FLAGGED (registry)');
  assert.deepEqual(reg(D.downDecisionMs), ['A:ASSIGNEE_DOWN!'], 'M1: AN ORPHAN THAT NEVER COMES BACK BECOMES A DECISION (registry)');
  const live = (age) => run(S, { registry: { jim: { id: 'jim' } }, liveness: { jim: lv('jim', 'EXITED', NOW - age, { lifecycle: 'ARCHIVED', archiveReason: 'orphan', archivedAt: NOW - age }) } });
  assert.deepEqual(live(D.bootGraceMs - 1), []);
  assert.deepEqual(live(D.bootGraceMs), ['A:ASSIGNEE_DOWN'], 'M1: AN ORPHAN THAT NEVER COMES BACK IS FLAGGED (liveness)');
  assert.deepEqual(live(D.downDecisionMs), ['A:ASSIGNEE_DOWN!'], 'M1: AN ORPHAN THAT NEVER COMES BACK BECOMES A DECISION (liveness)');
};
test('M1: an orphan that never comes back is flagged after the 5-minute grace, and becomes a decision', () => K.orphanNeverBackFlagged());

K.missingTimestampFailsSafe = (S = STALE) => {
  assert.deepEqual(run(S, { registry: { jim: { archived: true, archiveReason: 'orphan' } } }), ['A:ASSIGNEE_DOWN'],
    'AN ORPHAN WITH NO ARCHIVE TIME IS NOT TAKEN FOR A BOOT SWEEP (registry)');
  assert.deepEqual(run(S, { registry: { jim: { id: 'jim' } }, liveness: { jim: lv('jim', 'EXITED', NOW, { lifecycle: 'ARCHIVED', archiveReason: 'orphan' }) } }), ['A:ASSIGNEE_DOWN'],
    'AN ORPHAN WITH NO ARCHIVE TIME IS NOT TAKEN FOR A BOOT SWEEP (liveness)');
};
test('a missing archive time fails safe: flagged, never silently graced', () => K.missingTimestampFailsSafe());

K.livenessOrphanUsesRegistryTime = (S = STALE) => {
  const D = S.BOARD_STALE_DEFAULTS;
  const at = (age) => run(S, { registry: { jim: { archived: true, archiveReason: 'orphan', lastSeen: NOW - age } },
    liveness: { jim: lv('jim', 'EXITED', NOW, { lifecycle: 'ARCHIVED', archiveReason: 'orphan' }) } });
  assert.deepEqual(at(D.bootGraceMs - 1), [], 'A LIVENESS ORPHAN WITH NO archivedAt TAKES THE REGISTRY ARCHIVE TIME (inside the grace: no flag)');
  assert.deepEqual(at(D.bootGraceMs), ['A:ASSIGNEE_DOWN'], 'and is flagged once that grace is over');
};
test('Jim B5: a liveness orphan with no archivedAt is graced by the registry\'s archive time', () => K.livenessOrphanUsesRegistryTime());

K.ptyExitWins = (S = STALE) => {
  const orphanNow = { archived: true, archiveReason: 'orphan', lastSeen: NOW };
  const ptyExit = lv('jim', 'EXITED', NOW - H, { lifecycle: 'ARCHIVED', archiveReason: 'pty-exit', archivedAt: NOW - H });
  assert.deepEqual(run(S, { registry: { jim: orphanNow }, liveness: { jim: ptyExit } }), ['A:ASSIGNEE_DOWN!'], 'A PTY EXIT WINS OVER A FRESH BOOT ORPHAN');
};
test('S1: a pty exit from one source wins over a fresh boot orphan from the other', () => K.ptyExitWins());

// ─── BOARDMONITOR-DOUBLE-RAISE ──────────────────────────────────────────────────────────

function monitorRig(t, M = MONITOR) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-board-boot-'));
  const hive = new HiveManager(() => home);
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  hive.ensureHive();
  const root = hive.root();
  fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify({ godId: null, agents: {} }, null, 2));
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({ tasks: [doing('A', 'ghost')] }, null, 2));
  hive.ledgerGuard.check();
  const monitor = new M.BoardMonitor({ hive, now: () => Date.parse('2026-10-01T12:00:00.000Z') });
  const raised = () => fs.readFileSync(path.join(root, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((l) => l.kind === 'board-flag' && l.event === 'raised').length;
  return { monitor, raised };
}

K.startKeepsFlags = (t, M = MONITOR) => {
  const r = monitorRig(t, M);
  r.monitor.tick();                                  // the bootstrap's ledger-guard tick
  r.monitor.start(60_000);
  try {
    assert.equal(r.raised(), 1, 'START AFTER A TICK DOES NOT RAISE THE SAME FLAG TWICE');
  } finally { r.monitor.stop(); }
};
test('DOUBLE-RAISE: start after the bootstrap tick raises an extant flag once', (t) => K.startKeepsFlags(t));

// ─── MUTANT CENSUS ──────────────────────────────────────────────────────────────────────

const MUTANT_DIR = path.join(__dirname, '.mutants-board178');
function mutate(rel, edits, tag) {
  let text = readSource(rel);
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  text = text.replace(/from '(\.\.?\/[^']+)'/g, (_, m) => `from '${path.relative(MUTANT_DIR, path.join(ROOT, path.dirname(rel), m)).replace(/\\/g, '/')}'`);
  const file = path.join(MUTANT_DIR, `${tag}.ts`);
  fs.writeFileSync(file, text, 'utf8');
  return loadTs(path.relative(ROOT, file));
}

const MUTANTS = [
  { name: 'M10b: an orphan is graced forever (the must-fix M1)', file: 'src/shared/boardStale.ts', real: STALE,
    edits: [['  if (orphanAt !== undefined && now - orphanAt < cfg.bootGraceMs) return null;', '  if (orphanAt !== undefined) return null;']],
    killer: 'orphanNeverBackFlagged', dies: /AN ORPHAN THAT NEVER COMES BACK IS FLAGGED/ },
  { name: 'an orphan with no archive time is graced', file: 'src/shared/boardStale.ts', real: STALE,
    edits: [['  if (orphanAt !== undefined && now - orphanAt < cfg.bootGraceMs) return null;', "  if ((lvReason === 'orphan' || regArchive === 'boot') && (orphanAt === undefined || now - orphanAt < cfg.bootGraceMs)) return null;"]],
    killer: 'missingTimestampFailsSafe', dies: /AN ORPHAN WITH NO ARCHIVE TIME IS NOT TAKEN FOR A BOOT SWEEP/ },
  { name: 'the orphan flag is never escalated (since = now)', file: 'src/shared/boardStale.ts', real: STALE,
    edits: [['    const since = lv?.lifecycle === \'ARCHIVED\' ? (lv.archivedAt ?? lv.classifiedSince) : (regAt ?? now);', '    const since = now;']],
    killer: 'orphanNeverBackFlagged', dies: /AN ORPHAN THAT NEVER COMES BACK BECOMES A DECISION/ },
  { name: 'Jim B5: a liveness orphan ignores the registry archive time', file: 'src/shared/boardStale.ts', real: STALE,
    edits: [["  const orphanAt = lvReason === 'orphan' ? (lv?.archivedAt ?? regAt) :", "  const orphanAt = lvReason === 'orphan' ? lv?.archivedAt :"]],
    killer: 'livenessOrphanUsesRegistryTime', dies: /A LIVENESS ORPHAN WITH NO archivedAt TAKES THE REGISTRY ARCHIVE TIME/ },
  { name: 'S1: the pty-exit precedence removed', file: 'src/shared/boardStale.ts', real: STALE,
    edits: [["  if (lvReason === 'pty-exit' || regReason === 'pty-exit') {", '  if (false) {']],
    killer: 'ptyExitWins', dies: /A PTY EXIT WINS OVER A FRESH BOOT ORPHAN/ },
  { name: 'DOUBLE-RAISE: start forgets the raised flags (as 1.1.77)', file: 'src/main/boardMonitor.ts', real: MONITOR,
    edits: [['    // `keys` here would make that already-raised flag appear new and log a duplicate raise.\n    if (this.timer) { clearInterval(this.timer); this.timer = null; }', '    this.stop();']],
    killer: 'startKeepsFlags', dies: /START AFTER A TICK DOES NOT RAISE THE SAME FLAG TWICE/ },
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  fs.rmSync(MUTANT_DIR, { recursive: true, force: true });
  fs.mkdirSync(MUTANT_DIR, { recursive: true });
  try {
    for (const [i, m] of MUTANTS.entries()) {
      await t.test(`mutant: ${m.name}`, async (st) => {
        const mod = mutate(m.file, m.edits, `m${i}`);
        const call = (x) => (m.killer === 'startKeepsFlags' ? K[m.killer](st, x) : K[m.killer](x));
        await call(m.real);
        let died = null;
        try { await call(mod); } catch (e) { died = e; }
        assert.ok(died, `SURVIVED: "${m.name}" was not killed by ${m.killer}`);
        assert.ok(died instanceof assert.AssertionError, `"${m.name}" must die by ASSERTION, got: ${died && died.stack}`);
        assert.match(died.message, m.dies, `"${m.name}" died at the wrong assertion: ${died.message}`);
      });
    }
  } finally {
    fs.rmSync(MUTANT_DIR, { recursive: true, force: true });
  }
});
