'use strict';

/**
 * STARTUP-LATCH-QUIET-193 (1.1.93 P0). Two defects seen right after the 16:04:50 app start:
 *
 * (A) Jim, resumed and quiet, never latched condition 1: his inbox wake at 16:07:18 was REFUSED at
 *     STAGE with `startup:UNKNOWN:no-composer`, latched false, generation 438, and an empty
 *     startupScreen (header NONE, cursorRow '', footer []). He latched only at 16:07:29, after the
 *     Human opened his tab and typed. Cause: his pooled renderer terminal was never shown, so it
 *     kept xterm's default 80x24 while his PTY ran at the spawn grid 100x30. Claude's 100-wide
 *     rules wrapped into an 80 and a 20 piece, and no composer box can be found in that. The
 *     StartupProbe re-read only on output, so a quiet agent was never read again.
 * (B) god's queued message (16:05:16) was refused at COMMIT with `UNKNOWN:no-composer`. It found
 *     an empty `❯` with Claude's shortcuts panel open, then `STAGED_TEXT_NOT_POSITIVELY_VISIBLE`
 *     with "no usable needle": the text's first line was under MIN_NEEDLE (4) characters. A lone
 *     `?` typed into an empty Claude composer opens that panel. Also, god had latched at gen 8 on
 *     the first paint, before the 47.8k resume replay.
 *
 * Fixtures: the exact logged rows (as constants below) and a rig grid capture
 * (fixtures/startup-latch-quiet-193, claude under a temp HOME, never a live agent).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');

const SHARED = loadTs('src/shared/codexScreen.ts');
const TUI = loadTs('src/shared/tuiComposer.ts');
const OWNER = loadTs('src/main/automaticSubmit.ts');
const GUARD = loadTs('src/main/codexScreenGuard.ts');
const BOOT = loadTs('src/main/bootSubmitEvidence.ts');
const { ADMISSION_REASON } = loadTs('src/main/capacityAdmission.ts');
const ALLOW = { verdict: 'ALLOW', reason: ADMISSION_REASON.AVAILABLE, poolKey: null, state: null, workClass: 'ORDINARY_TURN', limitEpochAt: null };

const K = {};
const GRID = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'startup-latch-quiet-193', 'claude-resume-grid-mismatch.json'), 'utf8'));
const factsOf = (g, S = SHARED) => S.extractCodexScreen((i) => g.lines[i], g.lines.length, g.cursorRow);

/** log.jsonl 1792339638197, wake-screen-guard, Jim's STAGE refusal (verbatim fields). */
const JIM_STAGE_ROW = {
  provider: 'claude', phase: 'STAGE', reason: 'startup:UNKNOWN:no-composer', incarnation: 3,
  observedGeneration: 438, latched: false,
  startupScreen: { header: 'NONE', startingAfterHeader: false, cursorRow: '', footer: [] }
};

/** log.jsonl 1792339516618, wake-screen-guard, god's COMMIT refusal (verbatim screen). */
const RULE_194 = '─'.repeat(194);
const GOD_COMMIT_ROW = {
  provider: 'claude', phase: 'COMMIT', reason: 'UNKNOWN:no-composer', observedGeneration: 19, latched: true,
  screen: {
    cursorRow: '❯',
    footer: [
      RULE_194,
      '! for shell mode        double tap esc to clear input      ctrl + shift + _ to undo',
      '/ for commands          shift + tab to auto-accept edits   alt + v to paste images',
      '@ for file paths        ctrl + o for verbose output        alt + p to switch model',
      '/btw for side question  ctrl + t to toggle tasks           ctrl + s to stash prompt',
      'backslash (\\) + return (⏎) for     ctrl + g to edit in $EDITOR'
    ]
  }
};
/** god's COMMIT screen as rows: the composer's top rule, the cursor row, then the footer as logged
 *  (Claude indents the panel by two columns; the log trims it). */
function godCommitScreen() {
  const lines = [RULE_194, GOD_COMMIT_ROW.screen.cursorRow, ...GOD_COMMIT_ROW.screen.footer.map((r, i) => (i === 0 ? r : `  ${r}`))];
  return { lines, cursorRow: 1 };
}

// ─── (A) the grid: why Jim's screen showed no composer, and the align rule ──────────────────

K.mismatchedGridIsNoComposer = (S = SHARED) => {
  const f = factsOf(GRID.mismatched, S);
  const comp = TUI.classifyTuiComposer('claude', f);
  assert.equal(`startup:${comp.cls}:${comp.reason}`, JIM_STAGE_ROW.reason, 'THE 80x24 MIRROR OF A 100x30 PTY IS JIM\'S REFUSAL');
  assert.equal(TUI.tuiPastStartup(comp).open, false);
  assert.ok(f.tail.some((row) => /^─{20}$/.test(row)), 'a wrapped 20-column rule piece is on screen');
  const aligned = TUI.classifyTuiComposer('claude', factsOf(GRID.aligned, S));
  assert.deepEqual(aligned, { cls: 'READY', reason: 'empty-composer' }, 'THE SAME PTY, ALIGNED AND REDRAWN, SHOWS THE EMPTY COMPOSER');
  assert.equal(TUI.tuiPastStartup(aligned).open, true);
};
test('A: Jim\'s logged STAGE refusal is the 80x24 mirror of a 100x30 Claude; aligned and redrawn it is the empty composer', () => K.mismatchedGridIsNoComposer());

K.gridAlignRule = (S = SHARED) => {
  const term = { cols: GRID.mismatched.cols, rows: GRID.mismatched.rows };
  assert.equal(S.screenGridAction(term, GRID.ptyGrid, false), 'align', 'A NEVER-SHOWN TERMINAL OF ANOTHER GRID IS ALIGNED, NOT READ');
  assert.equal(S.screenGridAction(GRID.ptyGrid, GRID.ptyGrid, false), 'read');
  assert.equal(S.screenGridAction(term, GRID.ptyGrid, true), 'read', 'a sized host keeps its own fit');
  assert.equal(S.screenGridAction(term, undefined, false), 'read', 'no PTY grid: unchanged');
  assert.equal(S.screenGridAction(term, { cols: 0, rows: 0 }, false), 'read');
};
test('A: the align rule: a detached terminal whose grid differs from its PTY\'s is aligned; a sized host or no grid is read', () => K.gridAlignRule());

test('A wiring: main sends the PTY grid with a guard reading; the renderer aligns, redraws and answers no reading', () => {
  const index = readSource('src/main/index.ts');
  assert.match(index, /\.\.\.\(codex \? \{ codex: true, grid: ptyManager\.grid\(ptyId\) \} : \{\}\)/);
  const pty = readSource('src/main/pty.ts');
  assert.match(pty, /grid\(id: string\): \{ cols: number; rows: number \} \| undefined \{\s*const p = this\.sessions\.get\(id\)\?\.proc;\s*return p \? \{ cols: p\.cols, rows: p\.rows \} : undefined;/);
  const pool = readSource('src/renderer/src/components/terminalPool.ts');
  assert.match(pool, /const hostSized = host\.isConnected && host\.clientWidth > 0 && host\.clientHeight > 0;\s*if \(screenGridAction\(\{ cols: entry\.term\.cols, rows: entry\.term\.rows \}, req\.grid, hostSized\) === 'align' && req\.grid\) \{\s*try \{ entry\.term\.resize\(req\.grid\.cols, req\.grid\.rows\); \} catch \{[^}]*\}\s*void window\.cth\.redrawPty\(req\.ptyId\);\s*window\.cth\.answerScreenReading\(req\.requestId, null\);\s*return;/);
  // The align branch runs before the normal read, and only for guard (codex) readings.
  assert.ok(pool.indexOf("screenGridAction({ cols") < pool.indexOf("entry.term.write('', () => {\n      const tail"));
  // GTC M2 (Jim MUST 2): a shadow read never aligns or redraws; test/gtc-m2-196 runs it.
  assert.match(pool, /if \(req\.codex === true && req\.shadow !== true && entry\.opened && !entry\.exited\) \{/);
  const preload = readSource('src/preload/index.ts');
  assert.match(preload, /codex\?: boolean; grid\?: \{ cols: number; rows: number \} \}\) => void/);
});

// ─── (A) the probe: a quiet agent is read again without anyone typing ───────────────────────

function probeRig(Probe = GUARD.StartupProbe) {
  const r = { now: 0, seq: 0, timers: [], probes: 0, latched: false, latchOnProbe: Infinity };
  r.probe = new Probe({
    wanted: () => !r.latched,
    probe: () => { r.probes += 1; if (r.probes >= r.latchOnProbe) r.latched = true; return Promise.resolve(); },
    setTimer: (fn, ms) => { const t = { at: r.now + ms, seq: (r.seq += 1), fn }; r.timers.push(t); return t; },
    clearTimer: (t) => { r.timers = r.timers.filter((x) => x !== t); }
  });
  r.run = async (untilMs) => {
    for (;;) {
      await new Promise((res) => setImmediate(res));
      r.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = r.timers[0];
      if (!next || next.at > untilMs) { r.now = untilMs; return; }
      r.timers.shift();
      r.now = next.at;
      next.fn();
    }
  };
  return r;
}

K.quietAgentIsReadAgain = async (Probe) => {
  // Jim: output at spawn, a reading that cannot latch (the misaligned grid), then silence.
  const r = probeRig(Probe);
  r.latchOnProbe = 2;
  r.probe.output('pty-jim');
  await r.run(GUARD.STARTUP_PROBE_SETTLE_MS);
  assert.equal(r.probes, 1, 'the settle reading');
  await r.run(GUARD.STARTUP_PROBE_SETTLE_MS + GUARD.STARTUP_PROBE_RETRY_MS[0]);
  assert.equal(r.probes, 2, 'A QUIET UN-LATCHED PTY IS READ AGAIN WITH NO OUTPUT');
  assert.equal(r.latched, true);
  await r.run(10 * 60_000);
  assert.equal(r.probes, 2, 'a latched PTY is never read again');
  assert.equal(r.timers.length, 0);
};
test('A: a quiet un-latched PTY is read again with no output, and stops once latched', () => K.quietAgentIsReadAgain());

test('A: the retries are bounded, and output starts them over', async () => {
  const r = probeRig();
  r.probe.output('p');
  await r.run(10 * 60_000);
  assert.equal(r.probes, 1 + GUARD.STARTUP_PROBE_RETRY_MS.length, 'one settle reading, then each retry wait once');
  assert.equal(r.timers.length, 0, 'then nothing until the next output');
  r.probe.output('p');
  await r.run(r.now + 10 * 60_000);
  assert.equal(r.probes, 2 * (1 + GUARD.STARTUP_PROBE_RETRY_MS.length), 'output starts the retry waits over');
  r.probe.output('q');
  r.probe.cancel('q');
  await r.run(r.now + 10 * 60_000);
  assert.equal(r.probes, 2 * (1 + GUARD.STARTUP_PROBE_RETRY_MS.length), 'a cancelled PTY is not retried');
});

// ─── the owner, end to end ──────────────────────────────────────────────────────────────────

function rig(over = {}, Owner = OWNER.AutomaticSubmitOwner) {
  const r = { now: 1_000_000, seq: 0, timers: [], writes: [], guard: [], startup: [], gen: 8, prompt: '', settled: undefined,
    screen: GRID.aligned, afterStage: null, ...over };
  r.facts = () => (r.prompt && r.afterStage ? factsOf(r.afterStage) : factsOf(r.screen));
  r.deps = {
    resolvePty: () => 'pty-god',
    incarnation: () => 1,
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
    screenProvider: () => 'claude',
    readGuardScreen: (_id, tail) => Promise.resolve({
      facts: r.facts(), incarnation: 1, outputGeneration: r.gen,
      ...(tail === undefined ? {} : { promptTailMatches: r.prompt.endsWith(tail) })
    }),
    outputGeneration: () => r.gen,
    onScreenGuard: (rec) => r.guard.push(rec),
    onStartupReading: (rec) => r.startup.push(rec),
    ...(over.noSettledDep ? {} : { startupSettled: () => r.settled })
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
  return r;
}

// ─── (d) the Claude latch waits for the session to settle ───────────────────────────────────

K.firstPaintDoesNotLatch = async (Owner) => {
  // god: a composer on the first paint (gen 8), session not settled (the resume replay follows).
  const r = rig({ settled: false }, Owner);
  assert.equal(await r.settle(r.owner.observeStartup('pty-god')), false, 'THE FIRST PAINT OF A RESUME DOES NOT LATCH');
  assert.equal(r.owner.postHandoffLatched('pty-god'), false);
  assert.deepEqual([r.startup[0].open, r.startup[0].reason, r.startup[0].outputGeneration], [false, 'session-settling', 8]);
  const out = await r.settle(r.owner.submit({ requestId: 'q1', agentId: 'god', admissionClass: 'CAPACITY_GATED', text: 'check inbox' }));
  assert.deepEqual([out.kind, out.detail], ['REFUSED', 'startup:session-settling']);
  assert.equal(r.writes.length, 0, 'nothing typed');
  r.settled = true;
  assert.equal(await r.settle(r.owner.observeStartup('pty-god')), true, 'settled, the same composer latches');
};
test('d: a Claude composer seen before the session settled does not latch (god\'s gen-8 first paint); settled, it does', () => K.firstPaintDoesNotLatch());

test('d: no startupSettled dep, or undefined from it (agy, a provider without the proof): the composer alone latches', async () => {
  const a = rig({ noSettledDep: true });
  assert.equal(await a.settle(a.owner.observeStartup('pty-god')), true);
  const b = rig({ settled: undefined });
  assert.equal(await b.settle(b.owner.observeStartup('pty-god')), true);
  const c = rig({ settled: false });
  c.deps.startupSettled = () => { throw new Error('down'); };
  assert.equal(await c.settle(c.owner.observeStartup('pty-god')), false, 'a throwing proof is no proof');
});

test('d: settled = the session-up proof AND quiet output for STARTUP_LATCH_QUIET_MS', () => {
  const Q = BOOT.STARTUP_LATCH_QUIET_MS;
  assert.equal(BOOT.startupSettled(true, Q), true);
  assert.equal(BOOT.startupSettled(true, Q - 1), false, 'output too recent (the replay is still arriving)');
  assert.equal(BOOT.startupSettled(false, 60_000), false, 'no SessionStart (and not past the fallback)');
  assert.equal(BOOT.startupSettled(true, undefined), false, 'no such PTY');
});

test('d wiring: Claude PTYs get SessionStart + quiet; other providers undefined; the wiring passes it to the owner', () => {
  const index = readSource('src/main/index.ts');
  assert.match(index, /startupSettled: \(ptyId\) => \{\s*const agentId = ptyToAgent\.get\(ptyId\);\s*if \(ptyProvider\.get\(ptyId\) !== 'claude'\) return undefined;[\s\S]{0,120}const up = agentId \? bootHooks\.bootReady\(agentId, ptyManager\.livenessFacts\(ptyId\)\?\.spawnedAt \?\? 0, Date\.now\(\)\) : true;\s*return startupSettled\(up, ptyManager\.idleFor\(ptyId\)\);/);
  const wiring = readSource('src/main/automaticSubmitWiring.ts');
  assert.match(wiring, /startupSettled: w\.startupSettled,/);
});

// ─── (B) god's COMMIT: the help panel, and a leading key never typed alone ──────────────────

K.godCommitRowIsHelpPanel = () => {
  const f = factsOf(godCommitScreen());
  assert.equal(f.cursorRow, GOD_COMMIT_ROW.screen.cursorRow);
  assert.deepEqual(f.footer, GOD_COMMIT_ROW.screen.footer, 'the logged footer, row for row');
  const comp = TUI.classifyTuiComposer('claude', f, '?');
  assert.equal(`${comp.cls}:${comp.reason}`, GOD_COMMIT_ROW.reason, 'THE SHORTCUTS PANEL UNDER AN EMPTY COMPOSER IS GOD\'S REFUSAL');
};
test('B: god\'s logged COMMIT screen (empty composer, shortcuts panel) is UNKNOWN:no-composer', () => K.godCommitRowIsHelpPanel());

K.modeKeysRefused = (own = OWNER) => {
  assert.equal(own.claudeModeKey('?'), 'lone-?', 'A LONE ? IS A MODE KEY');
  assert.equal(own.claudeModeKey(' ? '), 'lone-?');
  assert.equal(own.claudeModeKey('!echo hi'), 'leading-!', 'A LEADING ! IS A MODE KEY');
  // Measured literal in ONE write (Creed's rig, Andy's section 11): deliverable.
  for (const t of ['?hello there', '? hi', '#note this', '@file', '/compact now please', 'check inbox', ' !x']) {
    assert.equal(own.claudeModeKey(t), null, `${JSON.stringify(t)} types as a draft`);
  }
  // No framing: single-line text is ONE raw write for every provider (#24; framing buys nothing through ConPTY).
  assert.equal(own.payloadFor('?hello there'), '?hello there');
  assert.equal(own.payloadFor('two\nlines'), '\x1b[200~two\nlines\x1b[201~', 'multi-line unchanged');
};
test('c: a lone ? or a leading ! is a Claude mode key; ?hello, ? hi, #, @, / and plain text type as a draft; no framing', () => K.modeKeysRefused());

K.questionMessageEndToEnd = async (Owner) => {
  // god's 16:05:16 queue message was under MIN_NEEDLE characters ("no usable needle"): a lone '?'
  // opens the panel god's COMMIT saw. It is refused with nothing typed; '?hello there' is staged
  // whole, in ONE write.
  const r = rig({ settled: true }, Owner);
  await r.settle(r.owner.observeStartup('pty-god'));
  const q = await r.settle(r.owner.submit({ requestId: 'q-1', agentId: 'god', admissionClass: 'CAPACITY_GATED', text: '?' }));
  assert.deepEqual([q.kind, q.reason, q.detail], ['REFUSED', 'TEXT_ENTERS_MODE', 'lone-?'], 'A \'?\' MESSAGE IS NEVER TYPED');
  const bang = await r.settle(r.owner.submit({ requestId: 'q-2', agentId: 'god', admissionClass: 'CAPACITY_GATED', text: '!echo hi' }));
  assert.deepEqual([bang.kind, bang.reason, bang.detail], ['REFUSED', 'TEXT_ENTERS_MODE', 'leading-!']);
  assert.deepEqual(r.writes, [], 'nothing typed');
  await r.settle(r.owner.submit({ requestId: 'q-3', agentId: 'god', admissionClass: 'CAPACITY_GATED', text: '?hello there' }));
  assert.equal(r.writes[0], '?hello there', 'THE STAGED TEXT IS ONE RAW WRITE');
};
test('c: a \'?\' or \'!x\' message is refused untyped; \'?hello there\' is staged whole in one raw write', () => K.questionMessageEndToEnd());

test('c: only Claude: agy and Codex texts are not judged by Claude\'s mode keys', async () => {
  const r = rig({ settled: true });
  r.deps.screenProvider = () => 'antigravity';
  await r.settle(r.owner.observeStartup('pty-god'));
  const out = await r.settle(r.owner.submit({ requestId: 'a-1', agentId: 'god', admissionClass: 'CAPACITY_GATED', text: '?' }));
  assert.notEqual(out.reason, 'TEXT_ENTERS_MODE');
});

// ─── (a) refusal rows carry a bounded tail and the staged text's first-char class ───────────

test('a: the staged text\'s first character, as a class', () => {
  const c = OWNER.stagedFirstChar;
  assert.deepEqual(['', ' x', '?', '!x', '/x', '#x', '@x', 'x'].map(c), ['empty', 'space', 'help', 'shell', 'command', 'memory', 'mention', 'text']);
});

K.commitRefusalCarriesTail = async (Owner) => {
  const r = rig({ settled: true, afterStage: godCommitScreen() }, Owner);
  await r.settle(r.owner.observeStartup('pty-god'));
  const out = await r.settle(r.owner.submit({ requestId: 'q-1', agentId: 'god', admissionClass: 'CAPACITY_GATED', text: '?hello there' }));
  assert.notEqual(out.kind, 'COMMITTED');
  const rec = r.guard.find((g) => g.phase === 'COMMIT' && !g.ok);
  assert.ok(rec, 'a COMMIT refusal');
  assert.equal(rec.reason, GOD_COMMIT_ROW.reason);
  assert.equal(rec.staged, 'help', 'A COMMIT REFUSAL NAMES THE STAGED FIRST-CHAR CLASS');
  assert.ok(Array.isArray(rec.tail) && rec.tail.length === OWNER.REFUSAL_TAIL_ROWS, 'A COMMIT REFUSAL CARRIES THE LAST ROWS');
  assert.ok(rec.tail.every((row) => row.length <= OWNER.STARTUP_ROW_MAX), 'each row clipped');
  assert.equal(rec.tail[rec.tail.length - 1].trim(), GOD_COMMIT_ROW.screen.footer[5]);
};
test('a: god\'s COMMIT refusal row carries the last 8 rows (clipped) and the staged class', () => K.commitRefusalCarriesTail());

test('a: a startup refusal (Jim\'s row) carries the bounded tail and the staged class', async () => {
  const r = rig({ settled: true, screen: GRID.mismatched });
  const out = await r.settle(r.owner.submit({ requestId: 'w-1', agentId: 'jim', admissionClass: 'CAPACITY_GATED', text: 'check inbox' }));
  assert.deepEqual([out.kind, out.detail], ['REFUSED', JIM_STAGE_ROW.reason]);
  const rec = r.guard[0];
  assert.equal(rec.latched, JIM_STAGE_ROW.latched);
  assert.equal(rec.staged, 'text');
  assert.ok(rec.startupScreen.tail.length > 0 && rec.startupScreen.tail.length <= OWNER.REFUSAL_TAIL_ROWS);
  assert.ok(rec.startupScreen.tail.some((row) => /^─{20}$/.test(row)), 'the wrapped rule piece is now in the log');
});

// ─── (b) startup readings: a repeat with new output is logged, others counted ───────────────

K.repeatReadingsLoggedPerGeneration = async (Owner) => {
  const r = rig({ settled: true, screen: GRID.mismatched }, Owner);
  await r.settle(r.owner.observeStartup('pty-god'));
  await r.settle(r.owner.observeStartup('pty-god'));
  assert.equal(r.startup.length, 1, 'the same generation is counted, not logged');
  r.gen += 5;
  await r.settle(r.owner.observeStartup('pty-god'));
  assert.equal(r.startup.length, 2, 'A REPEAT READING WITH NEW OUTPUT IS LOGGED');
  assert.deepEqual(r.startup.map((s) => [s.reason, s.outputGeneration, s.seen]), [['UNKNOWN:no-composer', 8, 1], ['UNKNOWN:no-composer', 13, 3]]);
  for (let i = 0; i < 3 * OWNER.STARTUP_READING_LOG_MAX; i += 1) { r.gen += 1; await r.settle(r.owner.observeStartup('pty-god')); }
  assert.equal(r.startup.length, OWNER.STARTUP_READING_LOG_MAX, 'bounded per reason');
};
test('b: a startup reading is logged again when the output generation moved (with its count), bounded', () => K.repeatReadingsLoggedPerGeneration());

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
  { name: 'probe: no retry without output', file: 'src/main/codexScreenGuard.ts',
    edits: [['    if (used >= this.retryMs.length) return;', '    return;']],
    run: (m) => K.quietAgentIsReadAgain(m.StartupProbe), dies: /A QUIET UN-LATCHED PTY IS READ AGAIN WITH NO OUTPUT/ },
  { name: 'grid: always read', file: 'src/shared/codexScreen.ts',
    edits: [["  return term.cols === pty.cols && term.rows === pty.rows ? 'read' : 'align';", "  return 'read';"]],
    run: (m) => K.gridAlignRule(m), dies: /A NEVER-SHOWN TERMINAL OF ANOTHER GRID IS ALIGNED/ },
  { name: 'd: the settled proof ignored', file: 'src/main/automaticSubmit.ts',
    edits: [['    if (!tui) return true;\n', '    return true;\n']],
    run: (m) => K.firstPaintDoesNotLatch(m.AutomaticSubmitOwner), dies: /THE FIRST PAINT OF A RESUME DOES NOT LATCH/ },
  { name: 'c: a lone ? is no mode key', file: 'src/main/automaticSubmit.ts',
    edits: [["  if (text.trim() === '?') return 'lone-?';\n", '']],
    run: (m) => K.modeKeysRefused(m), dies: /A LONE \? IS A MODE KEY/ },
  { name: 'c: a leading ! is no mode key', file: 'src/main/automaticSubmit.ts',
    edits: [["  return text.charAt(0) === '!' ? 'leading-!' : null;", '  return null;']],
    run: (m) => K.modeKeysRefused(m), dies: /A LEADING ! IS A MODE KEY/ },
  { name: 'c: the owner never asks', file: 'src/main/automaticSubmit.ts',
    edits: [["    if (modeKey) return this.refuse(null, 'TEXT_ENTERS_MODE', modeKey);\n", '']],
    run: (m) => K.questionMessageEndToEnd(m.AutomaticSubmitOwner), dies: /A '\?' MESSAGE IS NEVER TYPED/ },
  { name: 'a: a COMMIT refusal without the staged class', file: 'src/main/automaticSubmit.ts',
    edits: [["{ staged: stagedFirstChar(req.text) } : {})", '{} : {})']],
    run: (m) => K.commitRefusalCarriesTail(m.AutomaticSubmitOwner), dies: /A COMMIT REFUSAL NAMES THE STAGED FIRST-CHAR CLASS/ },
  { name: 'a: a COMMIT refusal without the tail', file: 'src/main/automaticSubmit.ts',
    edits: [['{ screen: screenFacts(r.facts), tail: refusalTail(r.facts) }', '{ screen: screenFacts(r.facts) }']],
    run: (m) => K.commitRefusalCarriesTail(m.AutomaticSubmitOwner), dies: /A COMMIT REFUSAL CARRIES THE LAST ROWS/ },
  { name: 'b: one row per reason again', file: 'src/main/automaticSubmit.ts',
    edits: [['      if (prev && (prev.gen === r.outputGeneration || prev.logged >= STARTUP_READING_LOG_MAX)) return;', '      if (prev) return;']],
    run: (m) => K.repeatReadingsLoggedPerGeneration(m.AutomaticSubmitOwner), dies: /A REPEAT READING WITH NEW OUTPUT IS LOGGED/ }
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, async () => {
      const mod = mutate(m.file, m.edits, m.name);
      await assert.rejects(async () => { await m.run(mod); }, m.dies);
    });
  }
});
