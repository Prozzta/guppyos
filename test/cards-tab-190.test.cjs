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
  id: t.id, title: t.title, status: t.status, assignee: t.assignee, createdAt: t.createdAt, description: t.description,
  dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.filter((d) => typeof d === 'string') : []
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
  assert.match(tab, /const \{ raw, meta \} = useHiveTasks\(\);/, 'the kanban data hook, no new store');
  assert.match(tab, /useMemo\(\(\) => reviewCards\(parseTasks\(raw\), rawById\(raw\), meta\), \[raw, meta\]\)/, 'the model is memoised on the raw ledger');
  assert.doesNotMatch(tab, /hive(Write|Delete|Update|Answer|Send)|window\.cth\.|create\(/, 'no write path');
  assert.doesNotMatch(tab, /onAnswer=/, 'the humanQA card is read-only');
  const kb = codeOnly(readSource('src/renderer/src/components/TasksKanban.tsx'), 'TasksKanban.tsx');
  assert.match(kb, /export function useHiveTasks\(\)/);
  assert.match(kb, /const \{ tasks, setTasks, flags, meta, refresh \} = useHiveTasks\(\);/);
});

// ---- Jim's audit of 953f6fec (CHANGES 2/2/2) ----

const { HumanQuestionCard } = loadTs('src/renderer/src/components/HumanQuestionCard.tsx');
const OPEN_ASK = { q: 'Which theme?', options: [{ label: 'Yes' }, { label: 'No' }], askedAt: '2026-10-16T18:00:00Z' };

test('MUST 1: an open ask in CARDS is read-only: no radio, no button, an OPEN tag that links to ASK ME', () => {
  const card = M.reviewCardOf(
    { id: 'ASK-1', title: 'asks', status: 'blocked', createdAt: '2026-10-16T17:00:00Z', dependsOn: [] },
    { humanQA: [OPEN_ASK, { ...OPEN_ASK, q: 'Gone ask', dismissedAt: '2026-10-16T18:30:00Z' }, { ...OPEN_ASK, q: 'Done ask', a: 'No', chosen: [1], answeredAt: '2026-10-16T19:00:00Z' }] },
    undefined
  );
  const html = view(card, { onOpenAskMe: () => {} });
  assert.doesNotMatch(html, /role="(radio|checkbox|radiogroup)"/, 'no radio anywhere on the card');
  assert.doesNotMatch(html, /<button[^>]*data-option/, 'options are not buttons');
  assert.match(html, /<li[^>]*data-option="0"[\s\S]*Yes/, 'options render as a plain list');
  assert.equal((html.match(/OPEN · <u>ANSWER ON ASK ME<\/u>/g) || []).length, 1, 'the open ask (only) carries the ASK ME link');
  assert.match(html, /<button[^>]*class="cth-hq-open"/, 'the tag is a link (a button calling onOpenAskMe)');
  assert.ok(html.includes('NOT ANSWERED'), 'a dismissed ask is not on ASK ME: no link, it reads NOT ANSWERED');
  assert.match(html, /data-option="1" data-chosen="true"[\s\S]*✓ No/, 'an answered ask marks the chosen option');
  // ASK ME's own card (no readOnly) is unchanged: open options stay choice buttons.
  const askme = renderToStaticMarkup(React.createElement(HumanQuestionCard, { entry: OPEN_ASK, now: NOW, onAnswer: () => {} }));
  assert.match(askme, /role="radio"/);
  assert.doesNotMatch(askme, /ANSWER ON ASK ME/);
  // and the click goes to the ASK ME tab, nowhere else
  const ct = codeOnly(readSource('src/renderer/src/components/CardsTab.tsx'), 'CardsTab.tsx');
  assert.match(ct, /onOpenAskMe = useCallback\(\(\) => requestCommandCenterTab\('human'\)/);
  const cv = codeOnly(readSource('src/renderer/src/components/CardsView.tsx'), 'CardsView.tsx');
  assert.match(cv, /<HumanQuestionCard [^>]*readOnly /);
});

test('Jim delta SHOULD: ANSWER ON ASK ME only on the ask ASK ME shows (a blocked card, its newest open entry)', () => {
  const qa = [{ ...OPEN_ASK, q: 'Older open ask' }, { ...OPEN_ASK, q: 'Newest open ask' }, { q: 'Answered', a: 'ok', askedAt: '2026-10-16T18:10:00Z' }];
  const of = (status) => M.reviewCardOf({ id: 'S-1', title: 's', status, createdAt: '2026-10-16T17:00:00Z', dependsOn: [] }, { humanQA: qa }, undefined);
  const links = (html) => (html.match(/ANSWER ON ASK ME/g) || []).length;
  // an open ask on a DONE card (4 on the real ledger): ASK ME never lists it, so no link
  for (const status of ['done', 'doing', 'todo']) {
    const card = of(status);
    assert.equal(card.humanQA.filter((e) => e.onAskMe).length, 0, status);
    const html = view(card, { onOpenAskMe: () => {} });
    assert.equal(links(html), 0, `${status}: no link`);
    assert.equal((html.match(/NOT ANSWERED/g) || []).length, 2, `${status}: both open asks read NOT ANSWERED`);
  }
  // blocked: only the newest open entry (openQuestion) links; the older one reads NOT ANSWERED
  const blocked = of('blocked');
  assert.deepEqual(blocked.humanQA.map((e) => !!e.onAskMe), [false, true, false]);
  const html = view(blocked, { onOpenAskMe: () => {} });
  assert.equal(links(html), 1);
  // each tag sits above its question: NOT ANSWERED, the older ask, the link, the newest ask
  const at = ['NOT ANSWERED', 'Older open ask', 'ANSWER ON ASK ME', 'Newest open ask'].map((s) => html.indexOf(s));
  assert.ok(at.every((v, i) => v >= 0 && (i === 0 || v > at[i - 1])), `order ${at}`);
  // parity: the model's rule is TasksKanban's openQuestion + waitsOnHuman
  const kb = codeOnly(readSource('src/renderer/src/components/TasksKanban.tsx'), 'TasksKanban.tsx');
  assert.match(kb, /if \(e && typeof e\.q === 'string' && !e\.a && !e\.dismissedAt\) return e;/);
  assert.match(kb, /return t\.status === 'blocked' && !!openQuestion\(t\);/);
  const mr = codeOnly(readSource('src/renderer/src/components/cardsReview.ts'), 'cardsReview.ts');
  assert.match(mr, /if \(task\.status === 'blocked'\) \{\s*for \(let i = rawQA\.length - 1; i >= 0; i--\)/);
  assert.match(mr, /if \(e && typeof e\.q === 'string' && !e\.a && !e\.dismissedAt\) \{ askMeEntry = e; break; \}/);
});

// A realistic card: 6 dated notes, a linked result, a humanQA entry with options (Jim measured
// ~2.6 ms per real card through renderToStaticMarkup).
const bigLedger = (n) => ({
  tasks: Array.from({ length: n }, (_, i) => ({
    id: `PERF-${i}`, title: `Perf card ${i} with a **title**`, status: i % 5 === 0 ? 'doing' : 'done', assignee: `agent-${i % 7}`,
    priority: i % 4, createdAt: new Date(Date.UTC(2026, 8, 1) + i * 60e3).toISOString(), dependsOn: i ? [`PERF-${i - 1}`] : [],
    notes: Array.from({ length: 6 }, (_, k) => `[${new Date(Date.UTC(2026, 9, 15, 12) + i * 60e3 + k * 1e3).toISOString()}] note ${k}: did **a thing** with \`code\` and https://example.com/${i}/${k}`).join('\n'),
    result: `[2026-10-15T10:00:00Z] released https://example.com/rel/${i}\n- a\n- b`,
    humanQA: [{ q: `Pick one for ${i}?`, options: [{ label: 'A', detail: 'the *first*' }, { label: 'B' }], askedAt: '2026-10-14T10:00:00Z', a: 'A', chosen: [0], answeredAt: '2026-10-14T11:00:00Z' }]
  }))
});

test('MUST 2: 900 cards with done on: the model builds once, the list renders the first 50 with SHOW MORE, in time', () => {
  const raw = bigLedger(900);
  const t0 = performance.now();
  const many = M.reviewCards(parseTasks(raw), M.rawById(raw), {});
  const t1 = performance.now();
  const html = renderToStaticMarkup(React.createElement(CardsView, { cards: many, nameFor, now: NOW, initialFilter: { ...M.DEFAULT_FILTER, showDone: true } }));
  const t2 = performance.now();
  assert.equal(many.length, 900);
  assert.equal((html.match(/class="cth-card-review"/g) || []).length, 50, 'only the first page is rendered');
  assert.ok(html.includes('900 of 900 cards'));
  assert.ok(html.includes('SHOW 50 MORE · 850 NOT SHOWN'));
  assert.ok(html.includes('data-card="PERF-899"'), 'the newest first');
  // 953f6fec rendered every card: ~1.95 s for 738. A page of 50 is ~0.15 s; the bound leaves
  // room for a loaded suite run and still fails a list that renders them all.
  console.log(`# 900 cards: model ${(t1 - t0).toFixed(0)} ms, render ${(t2 - t1).toFixed(0)} ms, html ${(html.length / 1024).toFixed(0)} KB`);
  assert.ok(t2 - t1 < 1000, `render took ${(t2 - t1).toFixed(0)} ms`);
  assert.ok(t1 - t0 < 500, `model took ${(t1 - t0).toFixed(0)} ms`);
});

test('MUST 2: memoised cards, a memoised model, unchanged polls keep identity, a debounced search', () => {
  assert.equal(ReviewCardView.$$typeof, Symbol.for('react.memo'), 'React.memo on the card');
  const { PAGE_SIZE, SEARCH_DEBOUNCE_MS } = loadTs('src/renderer/src/components/CardsView.tsx');
  assert.equal(PAGE_SIZE, 50);
  assert.equal(SEARCH_DEBOUNCE_MS, 150);
  const cv = codeOnly(readSource('src/renderer/src/components/CardsView.tsx'), 'CardsView.tsx');
  assert.match(cv, /value=\{typed\}[^>]*onChange=\{\(e\) => setTyped\(e\.target\.value\)\}/, 'keystrokes go to the box, not the filter');
  assert.match(cv, /setTimeout\(\(\) => setF\(\(cur\) => \(\{ \.\.\.cur, text: typed \}\)\), SEARCH_DEBOUNCE_MS\)/);
  assert.match(cv, /useMemo\(\(\) => filterCards\(cards, f, nameFor\), \[cards, f, nameFor\]\)/);
  assert.match(cv, /shown\.slice\(0, limit\)\.map/);
  const kb = codeOnly(readSource('src/renderer/src/components/TasksKanban.tsx'), 'TasksKanban.tsx');
  assert.match(kb, /if \(j !== seen\.current\.raw\) \{ seen\.current\.raw = j; setRaw\(r\); \}/, 'an unchanged poll keeps raw');
  assert.match(kb, /if \(j !== seen\.current\.meta\) \{ seen\.current\.meta = j; setMeta\(nextMeta\); \}/, 'an unchanged poll keeps meta');
  const ct = codeOnly(readSource('src/renderer/src/components/CardsTab.tsx'), 'CardsTab.tsx');
  assert.match(ct, /useStore\(\(s\) => nameKey\(s\.agents\)\)/, 'names by value: a status tick does not rebuild nameFor');
});

test('SHOULD 1: from CARDS the detail opens read-only: no move, no assign', () => {
  const ct = codeOnly(readSource('src/renderer/src/components/CardsTab.tsx'), 'CardsTab.tsx');
  assert.match(ct, /openTaskDetail\(id, \{ readOnly: true \}\)/);
  const st = codeOnly(readSource('src/renderer/src/store/store.ts'), 'store.ts');
  assert.match(st, /openTaskDetail: \(id, opts\) => set\(\{ taskDetailId: id, taskDetailReadOnly: opts\?\.readOnly === true \}\)/);
  assert.match(st, /closeTaskDetail: \(\) => set\(\{ taskDetailId: null, taskDetailReadOnly: false \}\)/);
  const ov = codeOnly(readSource('src/renderer/src/components/TaskDetailOverlay.tsx'), 'TaskDetailOverlay.tsx');
  assert.match(ov, /\{\.\.\.\(readOnly \? \{\} : \{ onMove: /, 'read-only passes neither handler');
  const kb = codeOnly(readSource('src/renderer/src/components/TasksKanban.tsx'), 'TasksKanban.tsx');
  assert.match(kb, /\{onMove && \(\s*<select/, 'no status select without onMove');
  assert.match(kb, /\{onAssign && \(\s*<PixelButton variant="secondary" size="sm" onClick=\{onAssign\}>/, 'no assign without onAssign');
});

test('SHOULD 2 + NIT 1: notes stored as an array are a timeline line each; deps are shown', () => {
  assert.deepEqual(M.parseTimeline(['[2026-10-01T00:00:00Z] one', 'two\nlines', 7, '', null, '[2026-10-02T00:00:00Z] three'], 'note').map((e) => [e.at, e.text]), [
    ['2026-10-01T00:00:00Z', 'one'], [null, 'two\nlines'], ['2026-10-02T00:00:00Z', 'three']
  ], 'each string on its own (an undated string does not join the entry above it)');
  const card = M.reviewCardOf(
    { id: 'ARR-1', title: 'array notes', status: 'doing', createdAt: '2026-10-01T00:00:00Z', dependsOn: ['A-1'] },
    { notes: ['[2026-10-03T00:00:00Z] newest', 'undated text'], deps: ['B-2', 'A-1'] },
    undefined
  );
  assert.deepEqual(card.timeline.map((e) => e.text), ['newest', 'undated text']);
  assert.deepEqual(card.deps, ['A-1', 'B-2'], 'dependsOn and a hand-written deps, once each');
  const html = view(card);
  assert.ok(html.includes('TIMELINE · 2'));
  assert.match(html, /DEPENDS ON <span[^>]*>A-1, B-2<\/span>/);
  assert.doesNotMatch(view(byId('DONE-1')), /DEPENDS ON/, 'no deps row on a card without deps');
});
