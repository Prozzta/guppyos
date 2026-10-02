'use strict';

/**
 * GOD-STARTUP-WAITS-ENTER (1.1.80). On 2026-10-02 (1.1.79) god's orientation and its Enter were
 * written 0.57 s after Claude's first output and 1.5 s BEFORE its SessionStart; Claude read text
 * and Enter as one paste, the Enter became a newline, and the prompt sat unsent until the Human
 * pressed Enter 22.6 s later, while the log said COMMITTED.
 *
 *   G1  a Claude boot prompt is typed only after this incarnation's SessionStart, plus a settle
 *       (with a fallback for a broken hook path);
 *   G2  it is COMMITTED only on this incarnation's UserPromptSubmit at or after the Enter; else at
 *       most ONE more Enter (own-draft proof, no person's key since), then INTERFERED
 *       BOOT_NOT_SUBMITTED, and the Human is told.
 *
 * Mutants that must die: MUTANT CENSUS at the bottom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');

const OWNER = loadTs('src/main/automaticSubmit.ts');
const EVID = loadTs('src/main/bootSubmitEvidence.ts');
const LEDGER = loadTs('src/main/mailLedger.ts');

const K = {};
const TEXT = "You're online as Michael, the orchestrator of the hive.";

// ─── the evidence clock (pure) ──────────────────────────────────────────────────────────────

/** The 2026-10-02 18:16 god start, as logged. */
const T = {
  spawn: Date.parse('2026-10-02T18:16:05.834Z'),
  oldEnter: Date.parse('2026-10-02T18:16:06.551Z'),
  sessionStart: Date.parse('2026-10-02T18:16:08.008Z')
};

K.waitsForSessionStart = (E = EVID) => {
  const c = new E.BootHookClock();
  assert.equal(c.bootReady('god', T.spawn, T.oldEnter), false, 'G1: NO BOOT WRITE BEFORE SESSIONSTART (where 1.1.79 typed)');
  c.note('god', 'SessionStart', T.sessionStart);
  assert.equal(c.bootReady('god', T.spawn, T.sessionStart + 200), false, 'G1: AND NOT BEFORE THE SETTLE');
  assert.equal(c.bootReady('god', T.spawn, T.sessionStart + E.BOOT_SESSION_SETTLE_MS), true, 'ready after SessionStart and the settle');
};
K.previousProcessProvesNothing = (E = EVID) => {
  const c = new E.BootHookClock();
  c.note('god', 'SessionStart', T.spawn - 60_000);
  assert.equal(c.bootReady('god', T.spawn, T.spawn + 5_000), false, 'G1: THE PREVIOUS PROCESS\'S SESSIONSTART PROVES NOTHING');
  c.note('god', 'UserPromptSubmit', T.spawn - 1);
  assert.equal(c.submittedSince('god', T.spawn, T.spawn - 10), false, 'nor its UserPromptSubmit');
};
K.submittedOnlyAfterEnter = (E = EVID) => {
  const c = new E.BootHookClock();
  c.note('god', 'UserPromptSubmit', T.spawn + 3_000);
  assert.equal(c.submittedSince('god', T.spawn, T.spawn + 4_000), false, 'G2: A PROMPT SUBMITTED BEFORE OUR ENTER IS NOT OURS');
  assert.equal(c.submittedSince('god', T.spawn, T.spawn + 3_000), true);
};
test('G1: a boot prompt waits for this incarnation\'s SessionStart and a settle (the 18:16 timeline)', () => K.waitsForSessionStart());
test('G1/G2: hooks of the previous process prove nothing', () => K.previousProcessProvesNothing());
test('G2: only a UserPromptSubmit at or after our Enter confirms it', () => K.submittedOnlyAfterEnter());

test('G1 fallback: no SessionStart 20 s after the spawn = the old rule (a broken hook path cannot cost the orientation)', () => {
  const c = new EVID.BootHookClock();
  assert.equal(c.bootReady('god', T.spawn, T.spawn + EVID.BOOT_SESSION_FALLBACK_MS - 1), false);
  assert.equal(c.bootReady('god', T.spawn, T.spawn + EVID.BOOT_SESSION_FALLBACK_MS), true);
  assert.equal(c.bootReady('god', 0, T.spawn + 60_000), false, 'no spawn time: never');
  c.note('god', 'Stop', T.spawn + 1); c.note(undefined, 'SessionStart', T.spawn + 1);
  assert.equal(c.bootReady('god', T.spawn, T.spawn + 2_000), false, 'other events, or no agent, are not kept');
});

// ─── the owner ──────────────────────────────────────────────────────────────────────────────

/**
 * A Claude terminal (no Codex screen gate). `r.ready` is G1's answer; `r.submitAfterEnter` (ms)
 * makes the provider report a UserPromptSubmit that long after an Enter, or never (null);
 * `r.human` is the person's key generation; `r.ownDraft` whether the composer still ends in our
 * text after the Enter.
 */
function rig(Owner = OWNER.AutomaticSubmitOwner, over = {}) {
  const r = { now: 1_000_000, seq: 0, timers: [], writes: [], interfered: [], prompt: '', human: 0, ready: true, submitAfterEnter: 300, submittedAt: null, ownDraft: true, provider: 'claude', ...over };
  r.deps = {
    resolvePty: () => 'pty-god',
    incarnation: () => 1,
    humanGeneration: () => r.human,
    write: (_id, d) => {
      r.writes.push(d);
      if (d === '\r') { if (r.submitAfterEnter !== null && r.submittedAt === null) r.submittedAt = r.now + r.submitAfterEnter; if (r.onEnter) r.onEnter(); }
      else r.prompt += d;
      return { ok: true };
    },
    terminalReady: () => 'READY',
    eligibility: () => ({ eligible: true }),
    promptBlock: () => null,
    lastHumanInputAt: () => undefined,
    abortCapability: () => ({ kind: 'VERIFIED', clearControl: '\x15', settleMs: 50 }),
    readScreen: (_id, _needle, tail) => Promise.resolve({ onPromptRow: r.ownDraft, screenCount: 1, promptTailMatches: r.ownDraft && tail !== undefined && r.prompt.endsWith(tail) }),
    capacity: { admit: () => { throw new Error('a boot prompt never asks capacity'); }, revalidate: () => { throw new Error('no'); }, confirmLaunch() {}, cancelGrant() {}, holdGrant() {} },
    now: () => r.now,
    setTimer: (fn, ms) => { r.timers.push({ at: r.now + ms, seq: (r.seq += 1), fn }); return {}; },
    screenGuard: () => 'OFF',
    onInterfered: (rec) => r.interfered.push(rec),
    bootReady: () => (r.provider === 'claude' ? r.ready : undefined),
    bootSubmitted: (_p, _a, since) => (r.provider === 'claude' ? r.submittedAt !== null && r.now >= r.submittedAt && r.submittedAt >= since : undefined),
    ...(over.deps ?? {})
  };
  r.owner = new Owner(r.deps);
  r.settle = async (promise) => {
    let done = false; let value;
    promise.then((v) => { done = true; value = v; });
    for (let i = 0; i < 20000; i += 1) {
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
  r.boot = (id = 'boot:god:1') => r.settle(r.owner.submit({ requestId: id, agentId: 'god', admissionClass: 'BOOT_SEQUENCE', text: TEXT }));
  return r;
}
const ENTERS = (r) => r.writes.filter((w) => w === '\r').length;

K.refusedBeforeSessionStart = async (Owner) => {
  const r = rig(Owner, { ready: false });
  const out = await r.boot();
  assert.deepEqual([out.kind, out.reason, out.detail], ['REFUSED', 'TERMINAL_NOT_READY', 'boot:session-not-started'], 'G1: REFUSED UNTIL SESSIONSTART');
  assert.deepEqual(r.writes, [], 'nothing typed');
};
test('G1: before SessionStart a boot prompt is REFUSED and nothing is typed (the caller asks again)', () => K.refusedBeforeSessionStart());

test('G2: an Enter the provider reports submitted is COMMITTED with ONE Enter', async () => {
  const r = rig();
  assert.equal((await r.boot()).kind, 'COMMITTED');
  assert.deepEqual(r.writes, [TEXT, '\r']);
});

K.unsentGetsOneMoreEnter = async (Owner) => {
  const r = rig(Owner, { submitAfterEnter: null });
  const out = await r.boot();
  assert.equal(ENTERS(r), 2, 'G2: EXACTLY ONE MORE ENTER, NEVER A THIRD');
  assert.deepEqual([out.kind, out.reason], ['INTERFERED', 'BOOT_NOT_SUBMITTED'], 'G2: STILL UNSENT = HELD FOR A PERSON');
  assert.equal(r.interfered[0].reason, 'BOOT_NOT_SUBMITTED');
};
test('G2: never reported submitted: one more Enter, then INTERFERED BOOT_NOT_SUBMITTED (no third)', () => K.unsentGetsOneMoreEnter());

test('G2: the second Enter that IS reported submitted is COMMITTED', async () => {
  const r = rig(undefined, { submitAfterEnter: null });
  let enters = 0;
  r.onEnter = () => { enters += 1; if (enters === 2) r.submittedAt = r.now + 200; };
  assert.equal((await r.boot()).kind, 'COMMITTED');
  assert.equal(ENTERS(r), 2);
});

K.noEnterAfterHumanKey = async (Owner) => {
  const r = rig(Owner, { submitAfterEnter: null });
  r.onEnter = () => { r.human += 1; };   // a person types right after our Enter
  const out = await r.boot();
  assert.equal(ENTERS(r), 1, 'G2: NO ENTER OF OURS AFTER A PERSON\'S KEY');
  assert.deepEqual([out.kind, out.reason], ['INTERFERED', 'BOOT_NOT_SUBMITTED'], 'G2: HELD AS BOOT_NOT_SUBMITTED, SO THE HUMAN IS TOLD');
  assert.match(r.interfered[0].detail, /a person typed/);
};
K.noEnterWithoutOwnDraft = async (Owner) => {
  const r = rig(Owner, { submitAfterEnter: null });
  r.onEnter = () => { r.ownDraft = false; };
  const out = await r.boot();
  assert.equal(ENTERS(r), 1, 'G2: NO SECOND ENTER WITHOUT THE OWN-DRAFT PROOF');
  assert.deepEqual([out.kind, out.reason], ['INTERFERED', 'BOOT_NOT_SUBMITTED']);
};
test('G2: a person\'s key after our Enter: no Enter of ours, held', () => K.noEnterAfterHumanKey());
test('G2: our text not provably still the composer: no Enter of ours, held', () => K.noEnterWithoutOwnDraft());

test('unchanged: a provider with no boot evidence keeps the old path (one Enter, COMMITTED), and other classes never ask G1', async () => {
  const r = rig(undefined, { provider: 'gemini', submitAfterEnter: null });
  assert.equal((await r.boot()).kind, 'COMMITTED');
  assert.deepEqual(r.writes, [TEXT, '\r']);
  const t = rig(undefined, { deps: { bootReady: () => { throw new Error('G1 asked for a non-boot class'); } } });
  t.deps.capacity = { admit: () => ({ verdict: 'ALLOW', reason: 'AVAILABLE', poolKey: null, state: null, workClass: 'ORDINARY_TURN', limitEpochAt: null }), revalidate: () => ({ verdict: 'ALLOW', reason: 'AVAILABLE', poolKey: null, state: null, workClass: 'ORDINARY_TURN', limitEpochAt: null }), confirmLaunch() {}, cancelGrant() {}, holdGrant() {} };
  t.owner = new OWNER.AutomaticSubmitOwner(t.deps);
  const out = await t.settle(t.owner.submit({ requestId: 'u1', agentId: 'god', admissionClass: 'USER_RELEASED', text: 'hi' }));
  assert.equal(out.kind, 'COMMITTED', JSON.stringify(out));
});

test('G1: a throwing evidence source refuses (nothing typed) rather than typing blind', async () => {
  const r = rig(undefined, { deps: { bootReady: () => { throw new Error('x'); } } });
  const out = await r.boot();
  assert.deepEqual([out.kind, out.detail], ['REFUSED', 'boot:session-not-started']);
  assert.deepEqual(r.writes, []);
});

// ─── telling the Human, and the wiring ─────────────────────────────────────────────────────

test('G2: the notice is plain words; a submitted prompt or a respawn lifts it', () => {
  const w = LEDGER.bootNotSubmittedNoticeText('Michael', 'not reported submitted after two Enters');
  assert.equal(w.title, 'Michael\'s start-up message was typed but not sent.');
  assert.match(w.notice, /click Michael's terminal\. If the message is sitting in the chat box, press Enter once\./);
  assert.doesNotMatch(`${w.title}\n${w.notice}`, /BOOT_|UserPromptSubmit|INTERFERED/, 'no jargon in what a person reads first');
  assert.match(w.details, /two Enters/);
  const index = readSource('src/main/index.ts');
  assert.match(index, /if \(r\.admissionClass === 'BOOT_SEQUENCE' && r\.reason === 'BOOT_NOT_SUBMITTED'\) \{\s*try \{ hive\.mail\.noteBootNotSubmitted\(r\.agentId, agentDisplayName\(r\.agentId\), r\.detail \?\? ''\); \}/);
  assert.match(index, /observe\(agentId, event, message, fullyIdle, turnId, source\);\s*noteBootHook\(agentId, event\);/, 'every hook the HookServer observes reaches the boot clock');
  assert.match(index, /bootHooks\.note\(agentId, event, Date\.now\(\)\);\s*if \(agentId && event === 'UserPromptSubmit'\) hive\.mail\.clearBootNotSubmitted\(agentId\);/);
  assert.match(index, /if \(res\.ok && opts\.hive\?\.id\) \{ try \{ hive\.mail\.clearBootNotSubmitted\(opts\.hive\.id\); \}/);
});

test('wiring: Claude PTYs get the hook evidence against THIS incarnation\'s spawn time; others get undefined', () => {
  const index = readSource('src/main/index.ts');
  assert.match(index, /bootReady: \(ptyId, agentId\) => \(ptyProvider\.get\(ptyId\) === 'claude'\s*\? bootHooks\.bootReady\(agentId, ptyManager\.livenessFacts\(ptyId\)\?\.spawnedAt \?\? 0, Date\.now\(\)\)\s*: undefined\)/);
  assert.match(index, /bootSubmitted: \(ptyId, agentId, since\) => \(ptyProvider\.get\(ptyId\) === 'claude'\s*\? bootHooks\.submittedSince\(agentId, ptyManager\.livenessFacts\(ptyId\)\?\.spawnedAt \?\? 0, since\)\s*: undefined\)/);
  const wiring = readSource('src/main/automaticSubmitWiring.ts');
  assert.match(wiring, /bootReady: w\.bootReady,\s*bootSubmitted: w\.bootSubmitted,/);
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
  { name: 'G1 off: the boot prompt is typed on terminal-ready (as shipped)', file: 'src/main/automaticSubmit.ts', owner: true,
    edits: [["      if (up === false) return this.refuse(decision, 'TERMINAL_NOT_READY', 'boot:session-not-started');\n", '']],
    killer: 'refusedBeforeSessionStart', dies: /G1: REFUSED UNTIL SESSIONSTART/ },
  { name: 'G1 clock: SessionStart alone, no settle', file: 'src/main/bootSubmitEvidence.ts',
    edits: [['    if (s !== undefined && s >= spawnedAt) return now - s >= settleMs;', '    if (s !== undefined && s >= spawnedAt) return true;']],
    killer: 'waitsForSessionStart', dies: /G1: AND NOT BEFORE THE SETTLE/ },
  { name: 'G1 clock: the previous process\'s SessionStart counts', file: 'src/main/bootSubmitEvidence.ts',
    edits: [['    if (s !== undefined && s >= spawnedAt) return now - s >= settleMs;', '    if (s !== undefined) return now - s >= settleMs;']],
    killer: 'previousProcessProvesNothing', dies: /THE PREVIOUS PROCESS'S SESSIONSTART PROVES NOTHING/ },
  { name: 'G2 clock: a prompt from before our Enter confirms it', file: 'src/main/bootSubmitEvidence.ts',
    edits: [['    return p !== undefined && spawnedAt > 0 && p >= spawnedAt && p >= since;', '    return p !== undefined && spawnedAt > 0 && p >= spawnedAt;']],
    killer: 'submittedOnlyAfterEnter', dies: /G2: A PROMPT SUBMITTED BEFORE OUR ENTER IS NOT OURS/ },
  { name: 'G2 off: COMMITTED on the Enter (as shipped)', file: 'src/main/automaticSubmit.ts', owner: true,
    edits: [["          if (cls === 'BOOT_SEQUENCE' && this.bootVerifiable(ptyId, req.agentId)) return this.verifyBootSubmitted(staged, enterAt);\n", '']],
    killer: 'unsentGetsOneMoreEnter', dies: /G2: EXACTLY ONE MORE ENTER, NEVER A THIRD/ },
  { name: 'G2: no human-key check before our second Enter', file: 'src/main/automaticSubmit.ts', owner: true,
    edits: [["    if (this.deps.humanGeneration(s.ptyId) !== s.humanStage) return this.interfere(s, 'BOOT_NOT_SUBMITTED', 'a person typed after our Enter');\n", '']],
    killer: 'noEnterAfterHumanKey', dies: /G2: HELD AS BOOT_NOT_SUBMITTED, SO THE HUMAN IS TOLD/ },
  { name: 'G2: no own-draft proof before our second Enter', file: 'src/main/automaticSubmit.ts', owner: true,
    edits: [["    if (!seen || seen.promptTailMatches !== true) return this.interfere(s, 'BOOT_NOT_SUBMITTED', 'not reported submitted, and the prompt is not provably our draft');\n", '']],
    killer: 'noEnterWithoutOwnDraft', dies: /G2: NO SECOND ENTER WITHOUT THE OWN-DRAFT PROOF/ },
  { name: 'G2: unsent after two Enters is called COMMITTED', file: 'src/main/automaticSubmit.ts', owner: true,
    edits: [["    return this.interfere(again, 'BOOT_NOT_SUBMITTED', 'not reported submitted after two Enters');", "    return { kind: 'COMMITTED' };"]],
    killer: 'unsentGetsOneMoreEnter', dies: /G2: STILL UNSENT = HELD FOR A PERSON/ }
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
