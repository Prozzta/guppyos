'use strict';
/**
 * WSG LIVENESS (rc/1.1.76 gate, ISO mail-rig-faults:68). Creed's deterministic repro, as a
 * regression: a Codex stub that processes (and so echoes) its stdin late. Before the fix, an
 * echo later than 3 x 250 ms gave INTERFERED SCREEN_NOT_VERIFIED_AFTER_STAGE
 * (READY:empty-composer, gen 2/2) and the agent sat held-interfered until a person ruled.
 *
 * Now:
 *  - an echo 1.5 s or 5 s late is waited for (SCREEN_COMMIT_SLOW_BUDGET_MS) and COMMITTED;
 *  - an echo later than the budget gets a VERIFIED erase (Ctrl-U, seen before, gone after):
 *    ABORTED, released, and the re-offer COMMITS once the load ends (also when the erase's own
 *    echo is late but inside the erase-verify budget: the re-read sees it gone);
 *  - never INTERFERED while the erase can be seen to work; an erase whose echo is past the
 *    erase-verify budget is held (INTERFERED ERASE_NOT_VERIFIED) with nothing more written;
 *  - never an Enter on an unverified screen.
 * Every outcome and screen-guard row is printed on failure (the seams from Creed's probe).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startRig, sleep } = require('./mail-rig/driver.cjs');

const T = { timeout: 180_000 };
const ID = 'cx-1';

async function outcomes(rig) {
  return (await rig.call('outcomes')).filter((o) => o.agentId === ID).map((o) => o.outcome);
}
async function story(rig) {
  const sg = (await rig.call('diags')).filter((d) => d.agentId === ID && d.stage === 'screen-guard').map((d) => d.why);
  return `outcomes ${JSON.stringify(await outcomes(rig))}\n  screen-guard: ${sg.join(' ; ')}`;
}
/** Beat about once a second until `pred(outcomes)` holds, or `beats` run out. */
async function beatUntil(rig, pred, beats) {
  for (let i = 0; i < beats; i += 1) {
    await rig.beat();
    await sleep(1000);
    const o = await outcomes(rig);
    if (pred(o)) return o;
  }
  return outcomes(rig);
}
const kinds = (o) => o.map((x) => x.kind);
/** After a few more beats: the stub received the wake EXACTLY ONCE (no second Enter, no doubling). */
async function assertOnePrompt(rig) {
  for (let i = 0; i < 5; i += 1) { await rig.beat(); await sleep(1000); }
  const prompts = rig.transcript(ID).filter((r) => r.kind === 'prompt');
  assert.equal(prompts.length, 1, `THE STUB RECEIVES EXACTLY ONE PROMPT\n  ${JSON.stringify(prompts)}\n  ${await story(rig)}`);
  // ...and exactly ONE Enter: a second Enter chasing a slow one would land on an empty composer.
  const enters = rig.transcript(ID).filter((r) => r.kind === 'pty-input').reduce((n, r) => n + (String(r.data).match(/\r/g) || []).length, 0);
  assert.equal(enters, 1, `THE STUB RECEIVES EXACTLY ONE ENTER, got ${enters}\n  ${await story(rig)}`);
}

for (const lag of [1500, 5000]) {
  test(`ISO echo lag ${lag} ms: the slow echo is waited for and COMMITTED, never held`, T, async (t) => {
    const rig = await startRig(t);
    await rig.setup([{ id: ID, flavour: 'codex', scenario: { echoLagMs: lag } }]);
    await rig.call('send', { to: ID, subject: 'lag', body: 'hello' });
    const o = await beatUntil(rig, (x) => x.some((y) => y.kind === 'COMMITTED' || y.kind === 'INTERFERED'), 40);
    const why = await story(rig);
    assert.ok(!kinds(o).includes('INTERFERED'), `A SLOW ECHO IS NEVER HELD FOR A PERSON\n  ${why}`);
    assert.ok(kinds(o).includes('COMMITTED'), `A SLOW ECHO IS COMMITTED\n  ${why}`);
    await assertOnePrompt(rig);
  });
}

// FLAKE-ISO-ECHO-LAG-191: the staged text and the erase each get their OWN lag. One 12 s lag for
// both left the erase 3.9 s inside its 0.9 s settle plus the 15 s erase-verify budget, so a loaded
// host (Ctrl-U written up to 5 s late) read it as not gone: INTERFERED, which is right for an erase it cannot see work.
// Load moves BOTH edges of the text's window: it delays the echo (measured: 64 burners on the half
// job delivered the staged text to the stub 14 s after the host wrote it), and it delays the host's
// last commit-budget reading until after an echo just past the budget (an 11 s lag COMMITTED under
// a 48-burner spike). So the text lag sits mid-window: 7.5 s past the 10 s commit budget and 7.5 s
// inside the 15 s seen budget the abort then re-reads for. The erase gets no lag of its own: the
// whole 0.9 s settle plus 15 s erase-verify budget.
const TEXT_LAG_MS = 17_500;

async function beyondBudget(t, eraseLagMs) {
  const rig = await startRig(t);
  await rig.setup([{ id: ID, flavour: 'codex', scenario: { echoLagMs: TEXT_LAG_MS, echoLagChunks: 1, echoLagAfterMs: eraseLagMs } }]);
  await rig.call('send', { to: ID, subject: 'lag', body: 'hello' });
  const first = await beatUntil(rig, (x) => x.some((y) => y.kind !== 'REFUSED'), 75);
  return { rig, first, settled: first.find((y) => y.kind !== 'REFUSED'), why: await story(rig) };
}

/** The first wake was erased and verified gone (ABORTED); once the load ends the re-offer COMMITS. */
async function assertAbortedThenCommits(rig, settled, why) {
  assert.ok(settled, `the first wake settles\n  ${why}`);
  assert.equal(settled.kind, 'ABORTED', `PAST THE BUDGET: A VERIFIED ERASE, NOT A HOLD\n  ${why}`);
  assert.match(settled.detail, /^screen-not-verified:/);
  rig.cue(ID, { cue: 'echo-lag', ms: 0 });                 // the load ends
  const after = await beatUntil(rig, (x) => x.some((y) => y.kind === 'COMMITTED' || y.kind === 'INTERFERED'), 60);
  why = await story(rig);
  assert.ok(!kinds(after).includes('INTERFERED'), `NEVER HELD FOR A PERSON\n  ${why}`);
  assert.ok(kinds(after).includes('COMMITTED'), `THE RE-OFFER COMMITS\n  ${why}`);
  await assertOnePrompt(rig);
}

test('ISO echo lag past the budget (text 17.5 s, erase 0 s): a VERIFIED erase (ABORTED), then the re-offer COMMITS once the load ends', T, async (t) => {
  const { rig, settled, why } = await beyondBudget(t, 0);
  await assertAbortedThenCommits(rig, settled, why);
});

// The late-erase re-read: the erase echo comes 7.5 s after the Ctrl-U, long after the first
// reading at settleMs, so only the bounded re-read (goneBy) can see it gone; 7.5 s of load room.
test('ISO late erase echo inside the budget (erase 7.5 s): the re-read sees it gone (ABORTED), then the re-offer COMMITS', T, async (t) => {
  const { rig, settled, why } = await beyondBudget(t, 7_500);
  await assertAbortedThenCommits(rig, settled, why);
});

// An erase that cannot be seen to work within the 15 s budget (echo 22.5 s late) is HELD for a
// person: the text may still be sendable, so nothing more is written (no Enter, never committed).
test('ISO erase echo past the budget (erase 22.5 s): INTERFERED ERASE_NOT_VERIFIED, held with no Enter', T, async (t) => {
  const { rig, settled, why } = await beyondBudget(t, 22_500);
  assert.ok(settled, `the first wake settles\n  ${why}`);
  assert.equal(settled.kind, 'INTERFERED', `AN UNVERIFIED ERASE IS HELD\n  ${why}`);
  assert.equal(settled.reason, 'ERASE_NOT_VERIFIED', why);
  assert.match(settled.detail, /^row=true count=1\/1$/, why);
  for (let i = 0; i < 5; i += 1) { await rig.beat(); await sleep(1000); }
  const o = await outcomes(rig);
  assert.ok(!kinds(o).includes('COMMITTED'), `NEVER COMMITTED WHILE HELD\n  ${await story(rig)}`);
  const enters = rig.transcript(ID).filter((r) => r.kind === 'pty-input').reduce((n, r) => n + (String(r.data).match(/\r/g) || []).length, 0);
  assert.equal(enters, 0, `NO ENTER ON AN UNVERIFIED SCREEN, got ${enters}\n  ${await story(rig)}`);
});
