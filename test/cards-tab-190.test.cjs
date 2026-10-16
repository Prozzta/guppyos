'use strict';

/**
 * CARDS-TAB-190: the Human's CARDS review tab (Command Center), replacing the Requests tab in the
 * tab bar. Read-only; one card per tasks.json card, in the look of ASK ME.
 *  - the model: '[iso] text' notes/result lines become one dated timeline, newest first, with
 *    undated text kept; the latest result; priority as written; parked/waitingFor/fixVersion;
 *    the humanQA history; newest activity first;
 *  - the filters: status, assignee, text, and done hidden unless toggled (or status=done);
 *  - long text collapses behind SHOW MORE; long timelines show 3 then SHOW N MORE;
 *  - the rendered card: facts, result, timeline, humanQA history through the read-only shared
 *    card (no answer controls), markdown through SafeMarkdown (no raw HTML);
 *  - the Requests tab and badge are hidden, not deleted; CARDS sits next to ask me; no write
 *    path in the tab.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const M = loadTs('src/renderer/src/components/cardsReview.ts');
const { firstOccurrenceById } = loadTs('src/shared/taskLedger.ts');
const { CardsView, ReviewCardView } = loadTs('src/renderer/src/components/CardsView.tsx');
// The typed tasks as parseTasks hands them over (TasksKanban pulls in the store, so not loaded here):
// the first record of an id, with the core fields the model reads.
const parseTasks = (raw) => firstOccurrenceById(raw.tasks, (t) => t.id).map((t) => ({
  id: t.id, title: t.title, status: t.status, assignee: t.assignee, createdAt: t.createdAt, description: t.description
}));

const NOW = new Date('2026-10-16T20:00:00Z');
const RAW = {
  tasks: [
    {
      id: 'BUSY-1', title: 'A busy card', status: 'doing', assignee: 'andy-1', priority: 0, createdAt: '2026-10-16T10:00:00Z',
      notes: '\n[2026-10-16T11:00:00.000Z] first note\n[2026-10-16T13:00:00.000Z] third note\nwith a second line\n[2026-10-16T12:00:00.000Z] second note\n[2026-10-16T14:00:00.000Z] fourth note',
      waitingFor: 'install', fixVersion: '1.1.90'
    },
    {
      id: 'DONE-1', title: 'A done card', status: 'done', assignee: 'jim-1', priority: 'high', createdAt: '2026-10-01T10:00:00Z',
      doneAt: '2026-10-02T10:00:00Z',
      result: 'hand-written summary\n[2026-10-02T09:00:00Z] built 1234abcd\n[2026-10-02T10:00:00Z] released https://example.com/rel'
    },
    {
      id: 'QA-1', title: 'A card that asked', status: 'blocked', assignee: 'dwight-1', createdAt: '2026-10-10T10:00:00Z', parked: true,
      humanQA: [
        { q: 'Which **one**?', options: [{ label: 'A', recommended: true }, { label: 'B' }], askedAt: '2026-10-10T11:00:00Z', a: 'A', answeredAt: '2026-10-10T12:00:00Z' },
        { q: 'Dismissed ask', askedAt: '2026-10-11T11:00:00Z', dismissedAt: '2026-10-11T12:00:00Z' },
        { nonsense: true }
      ]
    },
    { id: 'BUSY-1', title: 'a duplicate id', status: 'todo', createdAt: '2027-01-01T00:00:00Z' },
    { id: 'OLD-1', title: '<b onclick="x()">old</b>', status: 'todo', createdAt: '2026-09-01T00:00:00Z', prio: 2 }
  ]
};
const META = { 'BUSY-1': { statusSince: NOW.getTime() - 2 * 3600e3, statusSinceExact: true } };
const tasks = parseTasks(RAW);
const cards = M.reviewCards(tasks, M.rawById(RAW), META);
const byId = (id) => cards.find((c) => c.id === id);
const names = { 'andy-1': 'Andy', 'jim-1': 'Jim', 'dwight-1': 'Dwight' };
const nameFor = (id) => (id ? names[id] ?? id : undefined);

test('timeline: [iso] lines, continuation lines, undated lead text kept, newest first', () => {
  const t = M.parseTimeline('lead text\n[2026-10-01T00:00:00Z] a\nmore\n\n[bad] x\n[2026-10-02T00:00:00Z]  b', 'note');
  assert.deepEqual(t.map((e) => [e.at, e.text]), [
    [null, 'lead text'], ['2026-10-01T00:00:00Z', 'a\nmore\n\n[bad] x'], ['2026-10-02T00:00:00Z', 'b']
  ]);
  assert.deepEqual(M.parseTimeline(undefined, 'note'), []);
  assert.deepEqual(M.parseTimeline('  \n ', 'note'), []);
  assert.deepEqual(byId('BUSY-1').timeline.map((e) => e.text), ['fourth note', 'third note\nwith a second line', 'second note', 'first note']);
  assert.deepEqual(byId('DONE-1').timeline.map((e) => [e.source, e.text]), [
    ['result', 'released https://example.com/rel'], ['result', 'built 1234abcd'], ['result', 'hand-written summary']
  ], 'undated after dated');
});

test('card fields: latest result, priority as written, wait fields, humanQA history, first record of an id', () => {
  assert.equal(cards.length, 4, 'one card per id (the duplicate is dropped, as the kanban drops it)');
  assert.equal(byId('BUSY-1').title, 'A busy card');
  assert.equal(byId('DONE-1').result, 'released https://example.com/rel');
  assert.equal(byId('BUSY-1').result, null);
  assert.equal(byId('BUSY-1').priority, 'P0');
  assert.equal(byId('DONE-1').priority, 'high');
  assert.equal(byId('OLD-1').priority, 'P2', 'prio is read when priority is absent');
  assert.equal(byId('QA-1').priority, null);
  assert.equal(byId('BUSY-1').waitingFor, 'install');
  assert.equal(byId('BUSY-1').fixVersion, '1.1.90');
  assert.equal(byId('QA-1').parked, true);
  assert.equal(byId('BUSY-1').parked, undefined);
  assert.equal(byId('DONE-1').assignee, 'jim-1', 'a done card keeps its assignee');
  const qa = byId('QA-1').humanQA;
  assert.equal(qa.length, 2, 'invalid entries dropped, every valid one kept');
  assert.equal(qa[0].a, 'A');
  assert.equal(qa[1].dismissedAt, '2026-10-11T12:00:00Z');
  assert.equal(byId('BUSY-1').meta.statusSince, META['BUSY-1'].statusSince);
});

test('order: newest activity first (notes, results, humanQA, status age, doneAt all count)', () => {
  assert.deepEqual(cards.map((c) => c.id), ['BUSY-1', 'QA-1', 'DONE-1', 'OLD-1']);
  assert.equal(byId('BUSY-1').lastActivity, META['BUSY-1'].statusSince, 'the status change at 18:00 beats the 14:00 note');
  assert.equal(byId('QA-1').lastActivity, Date.parse('2026-10-11T12:00:00Z'), 'a dismissal is activity');
});

test('filters: done hidden by default, toggle and status=done show it; assignee; text over notes, result and QA', () => {
  const ids = (f) => M.filterCards(cards, { ...M.DEFAULT_FILTER, ...f }, nameFor).map((c) => c.id);
  assert.deepEqual(ids({}), ['BUSY-1', 'QA-1', 'OLD-1']);
  assert.deepEqual(ids({ showDone: true }), ['BUSY-1', 'QA-1', 'DONE-1', 'OLD-1']);
  assert.deepEqual(ids({ status: 'done' }), ['DONE-1']);
  assert.deepEqual(ids({ status: 'blocked' }), ['QA-1']);
  assert.deepEqual(ids({ assignee: 'andy-1' }), ['BUSY-1']);
  assert.deepEqual(ids({ assignee: '' }), ['OLD-1'], "'' = unassigned");
  assert.deepEqual(ids({ text: 'THIRD NOTE' }), ['BUSY-1']);
  assert.deepEqual(ids({ text: '1234abcd', showDone: true }), ['DONE-1']);
  assert.deepEqual(ids({ text: '1234abcd' }), [], 'text search respects the done toggle');
  assert.deepEqual(ids({ text: 'dismissed ask' }), ['QA-1']);
  assert.deepEqual(ids({ text: 'dwight' }), ['QA-1'], 'the assignee name matches');
});

test('collapse: short text untouched; long text cut at a boundary with an ellipsis', () => {
  assert.deepEqual(M.collapsed('short'), { text: 'short', cut: false });
  const long = 'word '.repeat(200);
  const c = M.collapsed(long);
  assert.equal(c.cut, true);
  assert.ok(c.text.length <= M.COLLAPSE_CHARS + 1);
  assert.match(c.text, /word…$/);
});

const view = (card, extra = {}) => renderToStaticMarkup(React.createElement(ReviewCardView, { card, assigneeName: nameFor(card.assignee), now: NOW, ...extra }));

test('render: a busy card shows its facts, age, wait tags and 3 of 4 timeline entries behind SHOW 1 MORE', () => {
  const html = view(byId('BUSY-1'));
  for (const s of ['A busy card', 'BUSY-1', 'DOING', 'ANDY', 'P0', 'WAITING FOR INSTALL', 'FIX 1.1.90', 'doing 2 h', 'TIMELINE · 4', 'SHOW 1 MORE', 'fourth note']) {
    assert.ok(html.includes(s), `has ${s}`);
  }
  assert.ok(!html.includes('first note'), 'the oldest entry is behind SHOW MORE');
  assert.ok(!html.includes('PARKED'));
});

test('render: a done card shows its assignee, result as markdown and done stamp; links are links', () => {
  const html = view(byId('DONE-1'));
  assert.match(html, /data-status="done"/);
  assert.ok(html.includes('JIM'));
  assert.ok(html.includes('HIGH'));
  assert.match(html, /cth-card-result[\s\S]*RESULT[\s\S]*<a href="https:\/\/example\.com\/rel"/);
  assert.ok(html.includes('done '));
});

test('render: humanQA history through the read-only shared card: question, options, answer, dismissed; no controls', () => {
  const html = view(byId('QA-1'));
  assert.ok(html.includes('ASKED THE HUMAN · 2'));
  assert.match(html, /<strong>one<\/strong>/, 'markdown as in ASK ME');
  assert.ok(html.includes('PARKED'));
  assert.ok(html.includes('dismissed '));
  assert.doesNotMatch(html, /<(textarea|input)[\s>]/, 'no answer box');
  assert.doesNotMatch(html, />\s*(SEND|ANSWER|SUBMIT)\s*</i, 'no answer button');
});

test('render: long text collapses behind SHOW MORE; raw HTML in a title stays text', () => {
  const long = { ...byId('BUSY-1'), result: 'x '.repeat(400), timeline: [] };
  const html = view(long);
  assert.match(html, /data-long="cut"/);
  assert.ok(html.includes('SHOW MORE'));
  const old = view(byId('OLD-1'));
  assert.doesNotMatch(old, /<b[\s>]/);
  assert.ok(old.includes('&lt;b onclick'));
});

test('list: default view hides done and says how to include it; counts; filtered-empty message', () => {
  const html = renderToStaticMarkup(React.createElement(CardsView, { cards, nameFor, now: NOW }));
  assert.ok(html.includes('3 of 4 cards'));
  assert.ok(html.includes('done (1)'));
  assert.ok(!html.includes('data-card="DONE-1"'));
  assert.ok(html.indexOf('data-card="BUSY-1"') < html.indexOf('data-card="QA-1"'), 'newest activity first');
  const none = renderToStaticMarkup(React.createElement(CardsView, { cards: [byId('DONE-1')], nameFor, now: NOW }));
  assert.match(none, /No card matches\. Done cards are hidden/);
  const all = renderToStaticMarkup(React.createElement(CardsView, { cards, nameFor, now: NOW, initialFilter: { ...M.DEFAULT_FILTER, showDone: true } }));
  assert.ok(all.includes('data-card="DONE-1"'));
});

test('wiring: CARDS next to ask me; Requests hidden, not deleted; the tab is read-only on the kanban hook', () => {
  const cc = codeOnly(readSource('src/renderer/src/components/CommandCenterPanel.tsx'), 'CommandCenterPanel.tsx');
  assert.match(cc, /\{ key: 'human', label: 'ask me', icon: 'bell' \},\s*\{ key: 'cards', label: 'cards'/);
  assert.match(cc, /tab === 'cards' && <CardsTab \/>/);
  assert.match(cc, /HIDDEN_TABS[^=]*= new Set<CCTab>\(\['requests'\]\)/);
  assert.match(cc, /visibleTabs = TABS\.filter\(\(t\) => !HIDDEN_TABS\.has\(t\.key\)/);
  assert.match(cc, /TABS\.some\(\(t\) => t\.key === key\) \|\| HIDDEN_TABS\.has\(key\)\) return/, 'an outside request cannot open a hidden tab');
  // kept intact: the entry, the badge, the render branch and the poll
  assert.match(cc, /key: 'requests'/);
  assert.match(cc, /tab === 'requests' && <OpenRequestsTab /);
  assert.match(cc, /useMailObligations\(\)/);
  const tab = codeOnly(readSource('src/renderer/src/components/CardsTab.tsx'), 'CardsTab.tsx')
    + codeOnly(readSource('src/renderer/src/components/CardsView.tsx'), 'CardsView.tsx');
  assert.match(tab, /const \{ tasks, raw, meta \} = useHiveTasks\(\);/, 'the kanban data hook, no new store');
  assert.match(tab, /reviewCards\(tasks, rawById\(raw\), meta\)/);
  assert.doesNotMatch(tab, /hive(Write|Delete|Update|Answer|Send)|window\.cth\.|create\(/, 'no write path');
  assert.doesNotMatch(tab, /onAnswer=/, 'the humanQA card is read-only');
  const kb = codeOnly(readSource('src/renderer/src/components/TasksKanban.tsx'), 'TasksKanban.tsx');
  assert.match(kb, /export function useHiveTasks\(\)/);
  assert.match(kb, /const \{ tasks, setTasks, flags, meta, refresh \} = useHiveTasks\(\);/);
});
