'use strict';
/**
 * IMPACT-LOOP-171: the useAgentImpact re-subscribe loop that ran the renderer out of memory on
 * 2026-09-27 22:03Z and 2026-09-28 01:06Z (MEMSPIKE-WHY, "Recurrence ... causal chain").
 *
 * useSyncExternalStore is replaced by a model of React's documented contract (react-dom 18):
 *   - on every render the hook passes (subscribe, getSnapshot); if `subscribe` is a different
 *     function from the last render, React UNSUBSCRIBES the old one and SUBSCRIBES the new one
 *     (passive effect), then re-checks the snapshot and re-renders if it changed;
 *   - a store notification re-renders when getSnapshot changed (Object.is).
 * Re-renders are queued and drained with a cap, so the v1.1.70 loop FAILS this test (it hits the
 * cap / issues thousands of reads) instead of hanging.
 *
 * The whole-App regression (a real React, a real renderer, main's real control:snapshot) is
 * test/impact-loop-171-harness.test.cjs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const loadTs = require('./load-ts.cjs');

const held = { kind: 'CAPACITY_RESERVE_ONLY', verb: 'paused', text: 'paused · Codex reserve only' };
const floorPause = { kind: 'DELIVERY_PAUSED', verb: 'paused', text: 'paused · auto-delivery off (floor)' };
const tick = () => new Promise((res) => setImmediate(res));

/** A fake window.cth: counts reads, answers them with `answer()`, and exposes the push channel. */
function bridge(answer) {
  const pushListeners = new Set();
  const b = {
    reads: 0,
    pushSubs: 0,
    controlSnapshot: () => { b.reads++; return Promise.resolve({ impact: answer() }); },
    onAgentImpact: (cb) => { b.pushSubs++; pushListeners.add(cb); return () => pushListeners.delete(cb); },
    push: (rows) => { for (const cb of pushListeners) cb({ rows }); },
    pushListeners
  };
  return b;
}

/** Mount one component that calls useAgentImpact(agentId), under the React model above. */
function mountModel(useAgentImpact, agentId, { maxRenders = 2000 } = {}) {
  const saved = React.useSyncExternalStore;
  const m = { renders: 0, subscribes: 0, unsubscribes: 0, value: undefined, capped: false };
  let cur = null; // { subscribe, getSnapshot, unsub }
  let queued = false;
  const listener = () => { if (cur && !Object.is(cur.getSnapshot(), m.value)) schedule(); };
  function schedule() { queued = true; }
  function renderOnce() {
    m.renders++;
    let passed = null;
    React.useSyncExternalStore = (subscribe, getSnapshot) => { passed = { subscribe, getSnapshot }; return getSnapshot(); };
    try { m.value = useAgentImpact(agentId); } finally { React.useSyncExternalStore = saved; }
    // commit: re-subscribe when the subscribe identity changed (React's effect deps = [subscribe])
    if (!cur || cur.subscribe !== passed.subscribe) {
      if (cur) { cur.unsub(); m.unsubscribes++; }
      cur = { ...passed, unsub: passed.subscribe(listener) };
      m.subscribes++;
      if (!Object.is(cur.getSnapshot(), m.value)) schedule();
    } else {
      cur.getSnapshot = passed.getSnapshot;
    }
  }
  function drain() {
    while (queued) {
      if (m.renders >= maxRenders) { m.capped = true; return; }
      queued = false;
      renderOnce();
    }
  }
  m.render = () => { renderOnce(); drain(); };
  m.settle = async (rounds = 30) => { for (let i = 0; i < rounds && !m.capped; i++) { await tick(); drain(); } };
  m.unmount = () => { if (cur) { cur.unsub(); m.unsubscribes++; cur = null; } };
  return m;
}

// The hook's stores are module-level and load-ts caches modules: every test uses its own agent ids.
const freshHook = () => loadTs('src/renderer/src/hooks/useAgentImpact.ts');

function withWindow(cth, fn) {
  const saved = global.window;
  global.window = { cth };
  return Promise.resolve().then(fn).finally(() => { global.window = saved; });
}

test('a HELD agent (non-null impact at mount): N re-renders never re-subscribe nor re-read, and nothing loops', async () => {
  const cth = bridge(() => held);
  await withWindow(cth, async () => {
    const { useAgentImpact } = freshHook();
    const m = mountModel(useAgentImpact, 'l171-dwight');
    m.render();
    await m.settle();
    assert.equal(m.capped, false, 'no render loop');
    assert.deepEqual(m.value, held, 'the held impact shows');
    assert.equal(cth.reads, 1, 'exactly one mount-time control:snapshot');
    const renders = m.renders;
    for (let i = 0; i < 50; i++) m.render();   // 50 unrelated re-renders (parent state, status ticks)
    await m.settle();
    assert.equal(m.subscribes, 1, 're-renders do not re-subscribe');
    assert.equal(m.unsubscribes, 0, 're-renders do not unsubscribe');
    assert.equal(cth.reads, 1, 're-renders do not re-issue control:snapshot');
    assert.equal(m.renders, renders + 50, 'no extra renders beyond the 50 asked for');
    m.unmount();
  });
});

test('the floor-wide delivery pause (every card non-null) does not loop either', async () => {
  const cth = bridge(() => floorPause);
  await withWindow(cth, async () => {
    const { useAgentImpact } = freshHook();
    const cards = ['l171-a', 'l171-b', 'l171-c'].map((id) => mountModel(useAgentImpact, id));
    for (const c of cards) c.render();
    for (const c of cards) await c.settle();
    for (const c of cards) { assert.equal(c.capped, false); assert.deepEqual(c.value, floorPause); assert.equal(c.subscribes, 1); }
    assert.equal(cth.reads, 3, 'one read per agent');
    for (const c of cards) c.unmount();
  });
});

test('a push still updates the value (and a late mount answer does not overwrite it)', async () => {
  let resolveRead;
  const cth = bridge(() => null);
  cth.controlSnapshot = () => { cth.reads++; return new Promise((res) => { resolveRead = res; }); };
  await withWindow(cth, async () => {
    const { useAgentImpact } = freshHook();
    const m = mountModel(useAgentImpact, 'l171-amy');
    m.render();
    assert.equal(cth.pushListeners.size, 1, 'one push subscription');
    cth.push([{ agentId: 'l171-amy', impact: held }]);
    await m.settle();
    assert.deepEqual(m.value, held, 'the push re-rendered the card with the hold');
    resolveRead({ impact: floorPause });
    await m.settle();
    assert.deepEqual(m.value, held, 'a mount answer older than the push is ignored');
    cth.push([{ agentId: 'l171-amy', impact: null }]);
    await m.settle();
    assert.equal(m.value, null, 'a cleared hold arrives by push');
    assert.equal(cth.reads, 1);
    assert.equal(m.subscribes, 1);
    m.unmount();
    assert.equal(cth.pushListeners.size, 0, 'the push channel is released when nothing shows an impact');
  });
});

test('a transient unsubscribe/resubscribe (StrictMode, remount) keeps the value and cannot loop', async () => {
  const cth = bridge(() => held);
  await withWindow(cth, async () => {
    const { useAgentImpact } = freshHook();
    const a = mountModel(useAgentImpact, 'l171-eve');
    a.render(); await a.settle();
    a.unmount();
    const b = mountModel(useAgentImpact, 'l171-eve');
    b.render();
    assert.deepEqual(b.value, held, 'the cached value shows at once on the remount');
    await b.settle();
    assert.equal(b.capped, false);
    assert.ok(cth.reads <= 2, `at most one re-read on a genuine remount (got ${cth.reads})`);
    b.unmount();
  });
});

test('source guards: one subscribe identity per agent; no value deleted on unsubscribe', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/renderer/src/hooks/useAgentImpact.ts'), 'utf8');
  assert.ok(!/useSyncExternalStore\(\s*agentId \? \(l\)/.test(src), 'no inline subscribe arrow passed to useSyncExternalStore');
  assert.match(src, /subscribeFor\(agentId\)/);
  assert.ok(!/values\.delete\(/.test(src), 'an unsubscribe never deletes the cached value');
});
