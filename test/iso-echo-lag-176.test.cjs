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
 *    ABORTED, released, and the re-offer COMMITS once the load ends;
 *  - never INTERFERED, never an Enter on an unverified screen.
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

test('ISO echo lag past the budget (12 s): a VERIFIED erase (ABORTED), then the re-offer COMMITS once the load ends', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: ID, flavour: 'codex', scenario: { echoLagMs: 12_000 } }]);
  await rig.call('send', { to: ID, subject: 'lag', body: 'hello' });
  const first = await beatUntil(rig, (x) => x.some((y) => y.kind !== 'REFUSED'), 60);
  let why = await story(rig);
  const settled = first.find((y) => y.kind !== 'REFUSED');
  assert.ok(settled, `the first wake settles\n  ${why}`);
  assert.equal(settled.kind, 'ABORTED', `PAST THE BUDGET: A VERIFIED ERASE, NOT A HOLD\n  ${why}`);
  assert.match(settled.detail, /^screen-not-verified:/);
  rig.cue(ID, { cue: 'echo-lag', ms: 0 });                 // the load ends
  const after = await beatUntil(rig, (x) => x.some((y) => y.kind === 'COMMITTED' || y.kind === 'INTERFERED'), 60);
  why = await story(rig);
  assert.ok(!kinds(after).includes('INTERFERED'), `NEVER HELD FOR A PERSON\n  ${why}`);
  assert.ok(kinds(after).includes('COMMITTED'), `THE RE-OFFER COMMITS\n  ${why}`);
  await assertOnePrompt(rig);
});
