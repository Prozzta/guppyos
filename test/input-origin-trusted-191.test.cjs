'use strict';
require('./tools/own-job.cjs');

/**
 * MODEL-NOT-KEPT-191 T1 - a TRUSTED keystroke on a rendered terminal classifies HUMAN.
 *
 * On 1.1.90 every key a person typed left the renderer as CONTROL: the same-tick window was
 * closed by a microtask, and a trusted dispatch runs a microtask checkpoint after each
 * listener, so it closed before xterm's handler emitted the bytes. main then never set
 * lastHumanInputAt, every model the Human picked in a terminal was pinned 'auto' and dropped
 * at the next restart, and the HUMAN_INPUT_* guards never fired. input-origin-harness.test.cjs
 * could not see it: its keys are script-dispatched. These come through Chromium's input pipeline.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { runScenario } = require('./electron-harness/run.cjs');

const scenario = join(__dirname, 'electron-harness', 'scenarios', 'input-origin-trusted.ts');
// One Electron run serves both tests.
let once = null;
const result = () => (once ??= runScenario(scenario, { timeoutMs: 120_000 }));

test('MODEL-NOT-KEPT-191 T1: a trusted letter, arrow and Enter in a terminal leave as HUMAN', async () => {
  const r = await result();
  assert.equal(r.ok, true, `scenario failed: ${r.error ?? ''}`);
  assert.equal(r.focused, true, 'the terminal textarea had focus');
  // The instrument: the keys really were trusted, one keydown each.
  assert.deepEqual(r.trusted, [true, true, true], `the page saw three trusted keydowns (${JSON.stringify(r.trusted)})`);
  for (const [name, data] of [['letter', 'm'], ['right', '\x1b[C'], ['enter', '\r']]) {
    const k = r.keys[name];
    assert.ok(k.data.includes(data), `${name}: xterm emitted ${JSON.stringify(data)} (got ${JSON.stringify(k.data)})`);
    assert.deepEqual(k.origin, k.data.map(() => 'HUMAN'), `${name}: every byte left as HUMAN (got ${JSON.stringify(k.origin)})`);
  }
  // The self-test still passes: the new window is the same one for a script dispatch.
  assert.equal(r.selfTest, 'pass', 'the startup self-test passes on the fixed window');
});

test('MODEL-NOT-KEPT-191 T1: protocol replies stay CONTROL around a trusted key (the twelve reply sites)', async () => {
  const r = await result();
  assert.equal(r.ok, true, `scenario failed: ${r.error ?? ''}`);
  // Twelve queries written from inside a trusted key's dispatch. XTWINOPS 18t is off by default
  // (windowOptions), so eleven replies come back; the key's own byte is the one HUMAN.
  const human = r.replies.filter((x) => x.origin === 'HUMAN').map((x) => x.data);
  const control = r.replies.filter((x) => x.origin === 'CONTROL').map((x) => x.data);
  assert.deepEqual(human, ['x'], `only the typed x is HUMAN (got ${JSON.stringify(r.replies)})`);
  assert.equal(control.length, 11, `eleven protocol replies, all CONTROL (got ${JSON.stringify(control)})`);
  for (const c of control) assert.equal(c.charCodeAt(0), 0x1b, `${JSON.stringify(c)} is a reply`);
  for (const shape of [/c$/, /\$y$/, /0n$/, /R$/, /\$r/, /\]10;/, /\]11;/, /\]4;1;/]) {
    assert.ok(control.some((c) => shape.test(c)), `a ${shape} reply came back CONTROL`);
  }
  // Program output delivered INSIDE the key's dispatch, after xterm emitted: xterm parses it
  // synchronously (first write after user input), and its CPR reply must still be CONTROL.
  assert.equal(r.deliveredInDispatch, true, 'the output really was delivered inside the dispatch');
  assert.deepEqual(r.outputInDispatch, [{ origin: 'HUMAN', data: '\x1b[C' }, { origin: 'CONTROL', data: '\x1b[1;1R' }],
    `the arrow is HUMAN, the in-dispatch CPR reply CONTROL (got ${JSON.stringify(r.outputInDispatch)})`);
});
