'use strict';
// BLOB-MESSAGE: the shared agent picker (src/renderer/src/blob/agentPicker.ts) is THE rule for who a
// Blob message, screenshot or meeting note can be sent to. Pure logic, fake enqueue: nothing is queued.
require('./tools/own-job.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const P = loadTs('src/renderer/src/blob/agentPicker.ts');

const AGENTS = [
  { id: 'zed', name: 'Zed', description: 'builder', ptyId: 'p1' },
  { id: 'god', name: 'God', description: 'orchestrator', ptyId: 'p0', isGod: true },
  { id: 'old', name: 'Old', description: 'retired', ptyId: 'p9', archived: true },
  { id: 'amy', name: 'Amy', description: 'tester', ptyId: '' },
  { id: 'zed', name: 'Zed again', description: 'dup', ptyId: 'p2' },
  { id: 'bob', name: 'Bob', description: 'reviewer', ptyId: 'p3' },
];
function fakeEnqueue() {
  const calls = [];
  const fn = (id, text, meta) => { calls.push([id, text, meta]); };
  fn.calls = calls;
  return fn;
}
const opts = () => P.agentPickerOptions(AGENTS, null);

test('options: archived never listed, duplicates once, orchestrator first then by name, no pty = unavailable', () => {
  const o = opts();
  assert.deepEqual(o.map((x) => x.id), ['god', 'amy', 'bob', 'zed']);
  assert.equal(o.some((x) => x.id === 'old'), false, 'archived agent is never an option');
  assert.equal(o.find((x) => x.id === 'zed').name, 'Zed', 'first occurrence wins');
  assert.equal(o[0].isOrchestrator, true);
  const amy = o.find((x) => x.id === 'amy');
  assert.equal(amy.available, false);
  assert.equal(amy.reason, 'not running');
  assert.equal(o.find((x) => x.id === 'bob').available, true);
  const byId = P.agentPickerOptions(AGENTS, 'bob');
  assert.equal(byId[0].id, 'bob', 'orchestratorId wins over isGod');
  assert.equal(byId.find((x) => x.id === 'god').isOrchestrator, false);
});

test('send: an archived agent is refused with "Pick an agent" and nothing is queued', () => {
  const q = fakeEnqueue();
  assert.deepEqual(P.sendToAgentVia(q, opts(), 'old', 'hi'), { ok: false, error: 'Pick an agent to send to.' });
  assert.equal(q.calls.length, 0);
});

test('send: an unknown or null id is refused and nothing is queued', () => {
  const q = fakeEnqueue();
  assert.deepEqual(P.sendToAgentVia(q, opts(), 'nobody', 'hi'), { ok: false, error: 'Pick an agent to send to.' });
  assert.deepEqual(P.sendToAgentVia(q, opts(), null, 'hi'), { ok: false, error: 'Pick an agent to send to.' });
  assert.equal(q.calls.length, 0);
});

test('send: an agent with no terminal is refused ("X is not running") and nothing is queued', () => {
  const q = fakeEnqueue();
  assert.deepEqual(P.sendToAgentVia(q, opts(), 'amy', 'hi'), { ok: false, error: 'Amy is not running.' });
  assert.equal(q.calls.length, 0);
});

test('send: empty or whitespace text is refused and nothing is queued', () => {
  const q = fakeEnqueue();
  for (const t of ['', '   ', '\n\t ', undefined, 42]) {
    assert.deepEqual(P.sendToAgentVia(q, opts(), 'bob', t), { ok: false, error: 'There is nothing to send.' }, `text ${JSON.stringify(t)}`);
  }
  assert.equal(q.calls.length, 0);
});

test('send: success queues once with (id, trimmed text, {human:true})', () => {
  const q = fakeEnqueue();
  assert.deepEqual(P.sendToAgentVia(q, opts(), 'bob', '  please review  \n'), { ok: true });
  assert.deepEqual(q.calls, [['bob', 'please review', { human: true }]]);
});

test('default: last-used only if available, then the orchestrator, then the first available, else null', () => {
  const o = opts();
  assert.equal(P.defaultPickerAgent(o, 'bob'), 'bob', 'available last-used wins');
  assert.equal(P.defaultPickerAgent(o, 'amy'), 'god', 'unavailable last-used falls to the orchestrator');
  assert.equal(P.defaultPickerAgent(o, 'old'), 'god', 'archived last-used falls to the orchestrator');
  assert.equal(P.defaultPickerAgent(o, null), 'god');
  assert.equal(P.defaultPickerAgent([...o].reverse(), null), 'god', 'the orchestrator wins wherever it sits in the list');
  const noGodUp = o.map((x) => (x.id === 'god' ? { ...x, available: false } : x));
  assert.equal(P.defaultPickerAgent(noGodUp, null), 'bob', 'orchestrator down: first available');
  assert.equal(P.defaultPickerAgent(o.map((x) => ({ ...x, available: false })), 'bob'), null, 'none available: null');
  assert.equal(P.defaultPickerAgent([], null), null);
});
