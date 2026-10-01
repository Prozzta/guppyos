'use strict';
/**
 * RIG-DESYNC (rc/1.1.76 final gate #2, round 1/b): the mail rig's Codex "screen" must never run
 * ahead of the PTY output the host has received.
 *
 * In the app a screen reading comes from xterm AFTER the bytes it covers are applied, stamped by
 * main with that output generation (automaticSubmitWiring.ts readGuardScreen; terminalPool.ts
 * term.write('', cb) barrier), so "the text is visible" and "its echo bytes arrived" are one event.
 * The rig read the stub's composer.json, which the stub writes BEFORE its echo: a reading could
 * show our text while that text's echo was still in flight, and when it landed (a new output
 * generation, text still there, the Enter queued behind it) WSG read it as "the Enter was lost"
 * and sent a second Enter.
 *
 * echoGapMs widens that gap on purpose; echoLagMs keeps the Enter queued behind the echo.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startRig, sleep } = require('./mail-rig/driver.cjs');

const ID = 'cx-1';

test('RIG FIDELITY: a screen reading never shows the stub\'s text before its echo reached the host (one Enter, never a chase)', { timeout: 180_000 }, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: ID, flavour: 'codex', scenario: { echoLagMs: 5000, echoGapMs: 1000 } }]);
  await rig.call('send', { to: ID, subject: 'gap', body: 'hello' });
  const outcomes = async () => (await rig.call('outcomes')).filter((o) => o.agentId === ID).map((o) => o.outcome);
  for (let i = 0; i < 40 && !(await outcomes()).length; i += 1) { await rig.beat(); await sleep(1000); }
  for (let i = 0; i < 5; i += 1) { await rig.beat(); await sleep(1000); }
  const sg = (await rig.call('diags')).filter((d) => d.agentId === ID && d.stage === 'screen-guard').map((d) => d.why);
  const why = `outcomes ${JSON.stringify(await outcomes())}\n  screen-guard: ${sg.join(' ; ')}`;
  const enters = rig.transcript(ID).filter((r) => r.kind === 'pty-input').reduce((n, r) => n + (String(r.data).match(/\r/g) || []).length, 0);
  assert.equal(enters, 1, `THE STUB RECEIVES EXACTLY ONE ENTER, got ${enters}\n  ${why}`);
  assert.ok((await outcomes()).some((o) => o.kind === 'COMMITTED'), `COMMITTED\n  ${why}`);
});

test('RIG FIDELITY n1: a received echo that fell out of the stub\'s window gives NO reading, never an empty composer', () => {
  const { screenDraftOf } = require('./mail-rig/screen-draft.cjs');
  const shown = [{ seq: 70, draft: 'a' }, { seq: 71, draft: 'ab' }];
  assert.equal(screenDraftOf(shown, 'ab', 69), null);
  assert.equal(screenDraftOf(shown, 'ab', 70), 'a');
  assert.equal(screenDraftOf([{ seq: 0, draft: '' }], '', 0), '');
  assert.equal(screenDraftOf(undefined, 'live', 5), 'live');
});
