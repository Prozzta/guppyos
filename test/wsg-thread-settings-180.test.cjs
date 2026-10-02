'use strict';

/**
 * DWIGHT-INPUT-DEAD-179 F4 (1.1.80, its own commit; Andy rules on it): a proof of Codex's
 * condition 1 (past its startup screens) that needs no screen marker. Codex 0.157.1 writes
 * `thread_settings_applied` to its rollout when the chat is configured (start or resume, inside
 * App::run, after the onboarding screens: tui/src/lib.rs:1306 before :2027). One stamped after
 * THIS incarnation was spawned latches condition 1. It only latches: every request still needs
 * its own fresh reading, which refuses a popup, a `loading` header or a resume line.
 *
 * Mutants that must die: MUTANT CENSUS at the bottom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');

const SHARED = loadTs('src/shared/codexScreen.ts');
const OWNER = loadTs('src/main/automaticSubmit.ts');
const LIFE = loadTs('src/main/codexRolloutLifecycle.ts');
const { ADMISSION_REASON } = loadTs('src/main/capacityAdmission.ts');
const ALLOW = { verdict: 'ALLOW', reason: ADMISSION_REASON.AVAILABLE, poolKey: null, state: null, workClass: 'ORDINARY_TURN', limitEpochAt: null };

const K = {};
const CWD = 'C:\\PrzEdit';
const FX = path.join(__dirname, 'fixtures', 'wake-screen-guard');

/** Dwight's rollout 01a0fda0 on 2026-10-02, payloads shortened: the 1.1.78 process's /model
 *  change, then the 1.1.79 process's resume (spawned 18:16:07.426Z). */
const settings = (ts, model) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: '01a0fda0', thread_settings: { model } } });
const DWIGHT_TAIL = [
  'id":"cut mid-line"}',
  settings('2026-10-02T17:59:58.663Z', 'gpt-6-luna'),
  JSON.stringify({ timestamp: '2026-10-02T18:03:12.714Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } }),
  settings('2026-10-02T18:14:46.742Z', 'gpt-5.6-terra'),
  settings('2026-10-02T18:16:09.048Z', 'gpt-5.6-terra'),
  ''
].join('\n');
const SPAWN_179 = Date.parse('2026-10-02T18:16:07.426Z');

// ─── reading the rollout ────────────────────────────────────────────────────────────────────

K.thisIncarnationOnly = (L = LIFE) => {
  assert.equal(L.latestThreadSettingsAt(DWIGHT_TAIL), Date.parse('2026-10-02T18:16:09.048Z'), 'the newest event');
  assert.equal(L.threadSettingsAppliedSince(L.latestThreadSettingsAt(DWIGHT_TAIL), SPAWN_179), true, 'Dwight 18:16: the 1.1.79 process configured its chat');
  const before = DWIGHT_TAIL.split('\n').slice(0, 4).join('\n');
  assert.equal(L.threadSettingsAppliedSince(L.latestThreadSettingsAt(before), SPAWN_179), false, 'THE PREVIOUS PROCESS\'S EVENT PROVES NOTHING');
  assert.equal(L.threadSettingsAppliedSince(null, SPAWN_179), false, 'no event');
  assert.equal(L.threadSettingsAppliedSince(Date.parse('2026-10-02T18:16:09.048Z'), 0), false, 'no spawn time');
};
test('F4: only a thread_settings_applied stamped after THIS spawn counts (Dwight\'s real rollout)', () => K.thisIncarnationOnly());

test('F4: the parser takes event_msg lines of that type only, and skips cut or foreign lines', () => {
  assert.equal(LIFE.latestThreadSettingsAt(''), null);
  assert.equal(LIFE.latestThreadSettingsAt('{"type":"response_item","timestamp":"2026-10-02T18:00:00Z","payload":{"type":"thread_settings_applied"}}'), null, 'not an event_msg');
  assert.equal(LIFE.latestThreadSettingsAt('{"type":"event_msg","timestamp":"nope","payload":{"type":"thread_settings_applied"}}'), null, 'no usable timestamp');
  assert.equal(LIFE.latestThreadSettingsAt('{"type":"event_msg","timestamp":"2026-10-02T18:00:00Z","payload":{"type":"task_started","note":"thread_settings_applied"}}'), null, 'the words in another event');
});

test('F4: the source reads the newest rollout of a CODEX_HOME and fails closed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-ts-180-'));
  try {
    const src = new LIFE.CodexRolloutLifecycleSource();
    assert.equal(src.threadSettingsAt(home), null, 'no sessions dir');
    const day = path.join(home, 'sessions', '2026', '10', '02');
    fs.mkdirSync(day, { recursive: true });
    const file = path.join(day, 'rollout-2026-10-02T19-19-24-01a0fda0.jsonl');
    fs.writeFileSync(file, DWIGHT_TAIL.split('\n').slice(1, 3).join('\n') + '\n');
    assert.equal(src.threadSettingsAt(home), Date.parse('2026-10-02T17:59:58.663Z'));
    fs.appendFileSync(file, settings('2026-10-02T18:16:09.048Z', 'gpt-5.6-terra') + '\n');
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(file, t, t);
    assert.equal(src.threadSettingsAt(home), Date.parse('2026-10-02T18:16:09.048Z'), 'a changed file is re-read');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ─── the owner ──────────────────────────────────────────────────────────────────────────────

/** A Codex chat box with NO marker: no header, and a status line naming another folder. */
const NO_MARKER = { lines: ['\u2022 a transcript row', '', '\u203a Ask Codex to do anything', '', '  gpt-5.5 high \u00b7 C:\\elsewhere'], cursorRow: 2 };
const factsOf = (s) => SHARED.extractCodexScreen((i) => s.lines[i], s.lines.length, s.cursorRow);

function rig(Owner = OWNER.AutomaticSubmitOwner, screen = NO_MARKER, threadConfigured = () => true) {
  const r = { now: 1_000_000, seq: 0, timers: [], writes: [], guard: [], startup: [], incarnation: 1, gen: 10, prompt: '' };
  const base = factsOf(screen);
  r.facts = () => (r.prompt ? { ...base, cursorRow: `\u203a ${r.prompt}` } : base);
  r.deps = {
    resolvePty: () => 'p1',
    incarnation: () => r.incarnation,
    humanGeneration: () => 0,
    write: (_id, d) => { r.writes.push(d); if (d === '\r') r.prompt = ''; else r.prompt += d; r.gen += 1; return { ok: true }; },
    terminalReady: () => 'READY',
    eligibility: () => ({ eligible: true }),
    promptBlock: () => null,
    lastHumanInputAt: () => undefined,
    abortCapability: () => ({ kind: 'VERIFIED', clearControl: '\x15', settleMs: 50 }),
    readScreen: () => Promise.resolve(null),
    capacity: { admit: () => ALLOW, revalidate: () => ALLOW, confirmLaunch() {}, cancelGrant() {}, holdGrant() {} },
    now: () => r.now,
    setTimer: (fn, ms) => { r.timers.push({ at: r.now + ms, seq: (r.seq += 1), fn }); return {}; },
    screenGuard: () => 'ENFORCE',
    readGuardScreen: (_id, tail) => Promise.resolve({
      facts: r.facts(), incarnation: r.incarnation, outputGeneration: r.gen,
      ...(tail === undefined ? {} : { promptTailMatches: r.prompt.endsWith(tail) })
    }),
    outputGeneration: () => r.gen,
    spawnCwd: () => CWD,
    onScreenGuard: (rec) => r.guard.push(rec),
    onStartupReading: (rec) => r.startup.push(rec),
    threadConfigured: threadConfigured === null ? undefined : threadConfigured
  };
  r.owner = new Owner(r.deps);
  r.settle = async (promise) => {
    let done = false; let value;
    promise.then((v) => { done = true; value = v; });
    for (let i = 0; i < 5000; i += 1) {
      await new Promise((res) => setImmediate(res));
      if (done) return value;
      assert.ok(r.timers.length, 'stuck: unsettled and no timer pending');
      r.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = r.timers.shift();
      r.now = Math.max(r.now, next.at);
      next.fn();
    }
    throw new Error('did not settle');
  };
  r.submit = (id = 'w1') => r.settle(r.owner.submit({ requestId: id, agentId: 'dwight', admissionClass: 'CAPACITY_GATED', text: '[hive] check inbox' }));
  return r;
}

K.submitLatchesOnThreadSettings = async (Owner) => {
  const r = rig(Owner);
  const out = await r.submit();
  assert.equal(out.kind, 'COMMITTED', `A CONFIGURED CHAT WITH NO SCREEN MARKER IS DELIVERED TO: ${JSON.stringify(out)}`);
  assert.deepEqual(r.writes, ['[hive] check inbox', '\r']);
};
K.startupLatchesOnThreadSettings = async (Owner) => {
  const r = rig(Owner);
  assert.equal(await r.settle(r.owner.observeStartup('p1')), true, 'THE STARTUP READING LATCHES ON THE THREAD PROOF');
  assert.deepEqual(r.startup.map((s) => [s.open, s.reason]), [[false, 'no-marker'], [true, 'thread-settings']], 'and both verdicts are logged');
  assert.equal(r.writes.length, 0, 'a startup reading types nothing');
};
K.blankScreenProvesNothing = async (Owner) => {
  const r = rig(Owner);
  r.gen = 0;
  assert.equal(await r.settle(r.owner.observeStartup('p1')), false, 'N1: A READING THAT COVERS NO OUTPUT LATCHES NOTHING');
};
test('F4: a delivery to a configured chat with no screen marker latches and commits', () => K.submitLatchesOnThreadSettings());
test('F4: the startup reading latches on it too, and logs which proof it was', () => K.startupLatchesOnThreadSettings());
test('F4: a reading that covers no output latches nothing (N1)', () => K.blankScreenProvesNothing());

test('F4: no proof, a false proof or a throwing proof changes nothing (still startup:no-marker)', async () => {
  for (const tc of [null, () => false, () => { throw new Error('fs'); }]) {
    const r = rig(undefined, NO_MARKER, tc);
    const out = await r.submit();
    assert.deepEqual([out.kind, out.detail], ['REFUSED', 'startup:no-marker']);
    assert.equal(r.writes.length, 0);
  }
});

test('F4 only latches: a loading header, a resume line and a popup are still refused with the proof', async () => {
  const fx = (name) => JSON.parse(fs.readFileSync(path.join(FX, `${name}.json`), 'utf8'));
  for (const [name, why] of [['2-trusted-draft', /^startup:header-loading$/], ['4-resume-resumedraft', /^startup:(header-loading|session-starting)$/]]) {
    const f = fx(name);
    const r = rig(undefined, { lines: f.lines, cursorRow: f.cursorRow });
    const out = await r.submit();
    assert.equal(out.kind, 'REFUSED', name);
    assert.match(out.detail, why, name);
    assert.equal(r.writes.length, 0);
  }
  const popup = { lines: ['  Approaching rate limits', '  Switch to gpt-6-luna for lower credit usage?', '', '\u203a 1. Switch to gpt-6-luna', '  2. Keep current model', '', '  Press enter to confirm or esc to go back'], cursorRow: 6 };
  const p = rig(undefined, popup);
  const out = await p.submit();
  assert.equal(out.kind, 'REFUSED');
  assert.match(out.detail, /^MODAL:/, 'a popup is never typed into');
  assert.equal(p.writes.length, 0);
});

test('F4 wiring: main asks Codex\'s newest rollout, against THIS incarnation\'s spawn time', () => {
  const index = readSource('src/main/index.ts');
  assert.match(index, /threadConfigured: \(ptyId\) => \{[\s\S]{0,400}const spawnedAt = ptyManager\.livenessFacts\(ptyId\)\?\.spawnedAt \?\? 0;[\s\S]{0,120}return threadSettingsAppliedSince\(codexLifecycle\.threadSettingsAt\(home\), spawnedAt\);/);
  assert.match(readSource('src/main/automaticSubmitWiring.ts'), /threadConfigured: w\.threadConfigured,/);
});

// ─── MUTANT CENSUS ──────────────────────────────────────────────────────────────────────────

function mutate(rel, edits, tag) {
  let text = readSource(rel);
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  return loadTs.fromText(rel, text);
}

const MUTANTS = [
  { name: 'F4: the previous process\'s event counts', file: 'src/main/codexRolloutLifecycle.ts',
    edits: [['  return at !== null && spawnedAt > 0 && at > spawnedAt;', '  return at !== null && spawnedAt > 0;']],
    killer: 'thisIncarnationOnly', dies: /THE PREVIOUS PROCESS'S EVENT PROVES NOTHING/ },
  { name: 'F4: the gate ignores the proof', file: 'src/main/automaticSubmit.ts', owner: true,
    edits: [['      else if (this.postHandoff.get(ptyId) !== incarnation && this.threadProof(ptyId, r)) this.postHandoff.set(ptyId, incarnation);', '']],
    killer: 'submitLatchesOnThreadSettings', dies: /A CONFIGURED CHAT WITH NO SCREEN MARKER IS DELIVERED TO/ },
  { name: 'F4: the startup reading ignores the proof', file: 'src/main/automaticSubmit.ts', owner: true,
    edits: [['    if (this.threadProof(ptyId, r)) {\n', '    if (false) {\n']],
    killer: 'startupLatchesOnThreadSettings', dies: /THE STARTUP READING LATCHES ON THE THREAD PROOF/ },
  { name: 'F4: a reading with no output may latch', file: 'src/main/automaticSubmit.ts', owner: true,
    edits: [['    if (r.outputGeneration <= 0) return false;\n    try { return this.deps.threadConfigured', '    try { return this.deps.threadConfigured']],
    killer: 'blankScreenProvesNothing', dies: /N1: A READING THAT COVERS NO OUTPUT LATCHES NOTHING/ }
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, async () => {
      const mod = mutate(m.file, m.edits, m.name);
      const arg = m.owner ? mod.AutomaticSubmitOwner : mod;
      await assert.rejects(async () => { await K[m.killer](arg); }, (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      });
    });
  }
});
