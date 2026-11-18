'use strict';
require('./tools/own-job.cjs');
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

const oneEnter = (echoGapMs) => async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: ID, flavour: 'codex', scenario: { echoLagMs: 5000, echoGapMs } }]);
  await rig.call('send', { to: ID, subject: 'gap', body: 'hello' });
  const outcomes = async () => (await rig.call('outcomes')).filter((o) => o.agentId === ID).map((o) => o.outcome);
  for (let i = 0; i < 40 && !(await outcomes()).length; i += 1) { await rig.beat(); await sleep(1000); }
  for (let i = 0; i < 5; i += 1) { await rig.beat(); await sleep(1000); }
  const sg = (await rig.call('diags')).filter((d) => d.agentId === ID && d.stage === 'screen-guard').map((d) => d.why);
  const why = `outcomes ${JSON.stringify(await outcomes())}\n  screen-guard: ${sg.join(' ; ')}`;
  const enters = rig.transcript(ID).filter((r) => r.kind === 'pty-input').reduce((n, r) => n + (String(r.data).match(/\r/g) || []).length, 0);
  assert.equal(enters, 1, `THE STUB RECEIVES EXACTLY ONE ENTER, got ${enters}\n  ${why}`);
  assert.ok((await outcomes()).some((o) => o.kind === 'COMMITTED'), `COMMITTED\n  ${why}`);
};

test('RIG FIDELITY: a screen reading never shows the stub\'s text before its echo reached the host (one Enter, never a chase)', { timeout: 180_000 }, oneEnter(1000));

// RIG-176-LOAD-FLAKE (1.1.91): a starved stub stretched the 1 s gap past SUBMIT_VERIFY_WINDOW_MS
// (2.5 s). The stub then printed the Enter's \r\n at once and the cleared composer a gap later,
// a split no TUI makes, and WSG read the quiet as "Enter lost" and sent a second one. A 4 s
// gap is that load, made certain: 5/5 runs got 2 Enters before the stub drew one frame per input.
test('RIG FIDELITY load: an echo gap longer than the verify window (a starved stub) still gets ONE Enter: the stub draws the Enter and its cleared composer in one frame', { timeout: 180_000 }, oneEnter(4000));

test('RIG FIDELITY n1: a received echo that fell out of the stub\'s window gives NO reading, never an empty composer', () => {
  const { screenDraftOf } = require('./mail-rig/screen-draft.cjs');
  const shown = [{ seq: 70, draft: 'a' }, { seq: 71, draft: 'ab' }];
  assert.equal(screenDraftOf(shown, 'ab', 69), null);
  assert.equal(screenDraftOf(shown, 'ab', 70), 'a');
  assert.equal(screenDraftOf([{ seq: 0, draft: '' }], '', 0), '');
  assert.equal(screenDraftOf(undefined, 'live', 5), 'live');
});

// MAIL-RIG-G1-STALE-MIRROR-108 (Jim 6a7b99): the stub's composer write was refused (EPERM) until it
// gave up, yet its echo went out. composer.json then ends at an OLDER seq (here the empty composer
// after an Enter) while the host has seen a NEWER echo (god's typed text). Reading the newest entry
// on disk showed '' for text the terminal shows, and G1's held look RELEASED god's draft.
test('RIG FIDELITY n2: a received echo NEWER than composer.json\'s newest seq (the file is behind) gives NO reading, never the stale composer', () => {
  const { screenDraftOf } = require('./mail-rig/screen-draft.cjs');
  const behind = [{ seq: 4, draft: 'wake' }, { seq: 5, draft: '' }];
  assert.equal(screenDraftOf(behind, '', 6), null, 'echo 6 seen, file ends at 5: no reading, not the empty composer');
  assert.equal(screenDraftOf(behind, '', 9), null, 'several echoes ahead: still no reading');
  assert.equal(screenDraftOf([{ seq: 0, draft: '' }], '', 1), null, 'the first echo seen before the first write landed');
  // the boundary: the newest seq on disk IS the seen echo, so its draft is the screen
  assert.equal(screenDraftOf(behind, '', 5), '');
  assert.equal(screenDraftOf([...behind, { seq: 6, draft: ' and god' }], ' and god', 6), ' and god');
});

// MAIL-RIG-G1-STALE-MIRROR-108 (c), Jim NIT 1: the rig's screen readers flush the PTY batcher FIRST
// (as pty.ts sendToOwner does before a product screen read), so buffered echoes reach the echoSeen
// scan before the reading. A source pin, not a timing test: it catches a deletion or a reorder.
test('RIG FIDELITY pin: readScreen and readCodexScreen flush the PTY batcher as their first statement', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'mail-rig', 'rig-host.cjs'), 'utf8');
  for (const reader of ['readScreen', 'readCodexScreen']) {
    const at = src.indexOf(`const ${reader} = async (ptyId`);
    assert.ok(at >= 0, `${reader} is defined in rig-host.cjs`);
    const body = src.slice(src.indexOf('=> {', at) + 4).trimStart();
    assert.equal(body.split('\n')[0].trim(), 'flushPtyOut(ptyId);', `${reader}'s first statement is the flush`);
  }
  assert.match(src, /const sessions = ptyManager\.sessions;[\s\S]{0,200}sessions\.get\(ptyId\)\?\.out\?\.flush\(\);/, 'flushPtyOut flushes the session\'s batcher');
});

// SUITE-LOAD-FLAKES-1027: the stub's composer.json is the screen the host reads. On Windows the
// stub's rename onto it is refused (EPERM) while any process has the file open, and the stub used
// to swallow that: the file kept the EMPTY composer, the host read an empty prompt row for text
// whose echo it had received, and every commit was refused as `empty-composer` until the wake gave
// up (INTERFERED, 0 Enters). Under full-suite load the host's own reads made that collision often
// enough to fail a different rig test each run. Here the collision is certain: this process holds
// the file open until the stub reports the refused write, so no load is needed to see it.
test('RIG FIDELITY write: a composer write refused while a reader has the file open is retried until it lands, never dropped (the staged text is read, ONE Enter)', { timeout: 180_000 }, async (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { waitFor } = require('./mail-rig/driver.cjs');
  const rig = await startRig(t);
  await rig.setup([{ id: ID, flavour: 'codex' }]);
  const recs = (kind) => rig.transcript(ID).filter((r) => r.kind === kind);
  let fd = fs.openSync(path.join(rig.stubDir(ID), 'composer.json'), 'r');
  t.after(() => { if (fd !== null) fs.closeSync(fd); });
  await rig.call('send', { to: ID, subject: 'held', body: 'hello' });
  const outcomes = async () => (await rig.call('outcomes')).filter((o) => o.agentId === ID).map((o) => o.outcome);
  await rig.beat();
  if (process.platform === 'win32') {
    await waitFor(() => recs('composer-write-blocked').length > 0, { what: 'the stub reported its composer write refused (the file is held open here)', timeoutMs: 60_000, diag: () => rig.diagnose(ID) });
  }
  fs.closeSync(fd); fd = null;
  for (let i = 0; i < 40 && !(await outcomes()).length; i += 1) { await rig.beat(); await sleep(1000); }
  const sg = (await rig.call('diags')).filter((d) => d.agentId === ID && d.stage === 'screen-guard').map((d) => d.why);
  const why = `outcomes ${JSON.stringify(await outcomes())}\n  screen-guard: ${sg.join(' ; ')}`;
  assert.deepEqual(recs('composer-write-failed'), [], `no composer write was given up on\n  ${why}`);
  if (process.platform === 'win32') assert.ok(recs('composer-write-retried').length > 0, `the refused write was retried until it landed\n  ${why}`);
  const enters = recs('pty-input').reduce((n, r) => n + (String(r.data).match(/\r/g) || []).length, 0);
  assert.equal(enters, 1, `THE STUB RECEIVES EXACTLY ONE ENTER, got ${enters}\n  ${why}`);
  assert.ok((await outcomes()).some((o) => o.kind === 'COMMITTED'), `COMMITTED\n  ${why}`);
});
