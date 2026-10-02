'use strict';

/**
 * HISTORY-VIEW-169: the History tab's renderer side.
 *  - the model keeps a BOUNDED, contiguous window (a renderer memory incident is why):
 *    following trims the oldest, paging older trims the newest and pauses following,
 *    and every trim is at a line boundary;
 *  - a new file (new session, rotated thread) or a reset reloads instead of merging;
 *  - virtualisation mounts only the rows in view;
 *  - the rows and list render (react-dom/server) as text, in theme tokens, with no
 *    raw colours, and the tab is wired beside TERMINAL.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');

const M = loadTs('src/renderer/src/components/historyModel.ts');
const { HistoryRow, HistoryList } = loadTs('src/renderer/src/components/HistoryView.tsx');

// One item per line except where noted; offsets are line starts (10 bytes a line).
const item = (offset, n = 0, kind = 'assistant', text = `t${offset}.${n}`) => ({ id: `${offset}.${n}`, kind, at: null, text, offset });
const page = (items, start, end, extra = {}) => ({ ok: true, provider: 'codex', fileId: 'f1', fileName: 'rollout.jsonl', items, start, end, atStart: start === 0, size: end, ...extra });

test('model: a tail page becomes a live window', () => {
  const w = M.applyTail(page([item(0), item(10)], 0, 20));
  assert.equal(w.live, true);
  assert.equal(w.atStart, true);
  assert.equal(w.items.length, 2);
  const u = M.applyTail({ ok: false, reason: 'no-transcript' });
  assert.equal(u.unavailable, 'no-transcript');
  assert.equal(u.fileId, null);
});

test('model: following appends and trims the OLDEST past the cap, at a line boundary', () => {
  let w = M.applyTail(page([item(0), item(10), item(20)], 0, 30), 4);
  // Line 30 yields two items; line 40 one.
  w = M.applyNewer(w, page([item(30, 0), item(30, 1), item(40)], 30, 50), 4);
  // 6 items, cap 4: drop 2 → items[2] is line 20, a new line, so the cut is exact.
  assert.deepEqual(w.items.map((i) => i.id), ['20.0', '30.0', '30.1', '40.0']);
  assert.equal(w.start, 20);
  assert.equal(w.end, 50);
  assert.equal(w.atStart, false);
  assert.equal(w.live, true);
  // A cut that would split line 30 drops the whole line instead.
  const x = M.applyNewer(w, page([item(50)], 50, 60), 4);
  assert.deepEqual(x.items.map((i) => i.id), ['30.0', '30.1', '40.0', '50.0']);
  const y = M.applyNewer(x, page([item(60)], 60, 70), 4);
  assert.deepEqual(y.items.map((i) => i.id), ['40.0', '50.0', '60.0'], 'line 30 goes whole, never half');
  assert.equal(y.start, 40);
});

test('model: an empty follow poll returns the same window (no re-render); a new file or reset reloads', () => {
  const w = M.applyTail(page([item(0)], 0, 10));
  assert.equal(M.applyNewer(w, page([], 10, 10)), w);
  assert.equal(M.applyNewer(w, page([], 10, 10, { fileId: 'f2' })), 'reload');
  assert.equal(M.applyNewer(w, page([], 0, 0, { reset: true })), 'reload');
  assert.equal(M.applyNewer(w, { ok: false, reason: 'unreadable' }), 'reload');
  assert.equal(M.applyNewer(w, page([item(30)], 30, 40)), 'reload', 'a gap is never merged');
});

test('model: paging older prepends; past the cap it trims the NEWEST and stops being live', () => {
  let w = M.applyTail(page([item(100), item(110), item(120)], 100, 130), 4);
  w = M.applyOlder(w, page([item(80), item(90, 0), item(90, 1)], 80, 100), 4);
  assert.deepEqual(w.items.map((i) => i.id), ['80.0', '90.0', '90.1', '100.0']);
  assert.equal(w.start, 80);
  assert.equal(w.end, 110, 'the window now ends before line 110');
  assert.equal(w.live, false, 'following pauses until the tail is reloaded');
  assert.equal(M.applyOlder(w, page([item(0)], 0, 50)), 'reload', 'not adjacent');
});

test('model: the retained history never exceeds HISTORY_RETAIN_MAX, however long it follows', () => {
  const { HISTORY_RETAIN_MAX } = loadTs('src/shared/history.ts');
  let w = M.applyTail(page([], 0, 0));
  let off = 0;
  for (let round = 0; round < 50; round += 1) {
    const items = [];
    const start = off;
    for (let k = 0; k < 100; k += 1) { items.push(item(off)); off += 10; }
    w = M.applyNewer(w, page(items, start, off));
    assert.ok(w.items.length <= HISTORY_RETAIN_MAX);
  }
  assert.equal(w.items.length, HISTORY_RETAIN_MAX);
  assert.equal(w.end, off);
});

test('virtualisation: only rows in the viewport plus overscan are mounted, with spacers for the rest', () => {
  const hs = new Array(1000).fill(50);
  const r = M.visibleRange(hs, 10000, 500, 100);
  assert.equal(r.first, 198);
  assert.equal(r.last, 212);
  assert.equal(r.padTop, 198 * 50);
  assert.equal(r.padTop + (r.last - r.first) * 50 + r.padBottom, 50000);
  const top = M.visibleRange(hs, 0, 500, 100);
  assert.equal(top.first, 0);
  assert.equal(top.last, 12);
  const empty = M.visibleRange([], 0, 500);
  assert.deepEqual([empty.first, empty.last, empty.padTop, empty.padBottom], [0, 0, 0, 0]);
});

test('render: rows are text in theme tokens: a user box, an agent box, a one-line tool, a system divider', () => {
  const at = new Date('2026-01-01T10:11:12').getTime();
  const user = renderToStaticMarkup(React.createElement(HistoryRow, { item: { id: '0.0', kind: 'user', at, text: '<b>hi</b>\nthere', offset: 0 } }));
  assert.match(user, /data-kind="user"/);
  assert.match(user, /USER/);
  assert.match(user, /10:11:12/);
  assert.match(user, /&lt;b&gt;hi&lt;\/b&gt;\nthere/, 'text, never markup');
  assert.match(user, /white-space:pre-wrap/);
  const tool = renderToStaticMarkup(React.createElement(HistoryRow, { item: { id: '1.0', kind: 'tool', at: null, text: 'Bash: npm test', offset: 1 } }));
  assert.match(tool, /data-kind="tool"/);
  assert.match(tool, /white-space:nowrap/);
  assert.match(tool, /text-overflow:ellipsis/);
  const sys = renderToStaticMarkup(React.createElement(HistoryRow, { item: { id: '2.0', kind: 'system', at: null, text: 'Context compacted', offset: 2 } }));
  assert.match(sys, /Context compacted/);
  const trunc = renderToStaticMarkup(React.createElement(HistoryRow, { item: { id: '3.0', kind: 'assistant', at: null, text: 'long', truncated: true, offset: 3 } }));
  assert.match(trunc, /AGENT/);
  assert.match(trunc, /\(truncated\)/);
  for (const html of [user, tool, sys, trunc]) {
    assert.doesNotMatch(html, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'theme tokens only, no raw colours');
  }
});

test('render: the list mounts only its range, offers Load older / Jump to latest, and explains an unavailable source', () => {
  const items = Array.from({ length: 50 }, (_, i) => item(i * 10, 0, i % 2 ? 'assistant' : 'user'));
  const win = { ...M.applyTail(page(items, 100, 600)), atStart: false };
  const html = renderToStaticMarkup(React.createElement(HistoryList, { win, first: 10, last: 15, padTop: 440, padBottom: 1540, loading: false, following: false }));
  assert.equal((html.match(/data-hid=/g) || []).length, 5, 'only the visible range is in the DOM');
  assert.match(html, /height:440px/);
  assert.match(html, /Load older/);
  assert.match(html, /Jump to latest/);
  const live = renderToStaticMarkup(React.createElement(HistoryList, { win: { ...win, atStart: true }, first: 0, last: 0, padTop: 0, padBottom: 0, loading: false, following: true }));
  assert.match(live, /Start of this session/);
  assert.doesNotMatch(live, /Jump to latest/);
  const none = renderToStaticMarkup(React.createElement(HistoryList, { win: M.applyTail({ ok: false, reason: 'unsupported-provider' }), first: 0, last: 0, padTop: 0, padBottom: 0, loading: false, following: true }));
  assert.match(none, /does not write one/);
});

test('wiring: a HISTORY tab beside TERMINAL, restored after restart, rendering HistoryView for the agent', () => {
  const tabs = readSource('src/renderer/src/components/SidebarTabs.tsx');
  assert.match(tabs, /key: 'terminal'[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*\{ key: 'history'/);
  const store = readSource('src/renderer/src/store/store.ts');
  assert.match(store, /export type SidebarTab = 'terminal' \| 'history'/);
  assert.match(store, /v === 'history'/);
  const panel = readSource('src/renderer/src/components/AgentDetailPanel.tsx');
  // HISTORY-SCROLL-FREEZE F3: the tab renders HistoryView inside its own error boundary.
  assert.match(panel, /sidebarTab === 'history' && \([\s\S]{0,200}?<ErrorBoundary key=\{agent\.id\} where="History">\s*<HistoryView agentId=\{agent\.id\} \/>/);
  const preload = readSource('src/preload/index.ts');
  assert.match(preload, /historyPage: \(req: HistoryRequest\): Promise<HistoryPage> =>\s*ipcRenderer\.invoke\('hive:history', req\)/);
  const main = readSource('src/main/index.ts');
  assert.match(main, /ipcMain\.handle\('hive:history', \(_evt, req: unknown\) => historyService\.page\(req\)\)/);
});
