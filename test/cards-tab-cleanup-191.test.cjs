'use strict';

/**
 * CARDS-TAB-CLEANUP-191: in the CARDS tab, done cards stay hidden by default behind a visible
 * "SHOW DONE (n)" toggle (a button, not the small "done (n)" checkbox of 1.1.90), and the choice
 * is remembered per viewer (this renderer's localStorage, under the cth. prefix that a fresh-home
 * reset clears). A storage that is missing or throws means hidden, never a crash.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const M = loadTs('src/renderer/src/components/cardsReview.ts');
const { CardsView } = loadTs('src/renderer/src/components/CardsView.tsx');

const NOW = new Date('2026-10-17T08:00:00Z');
const task = (id, status) => ({ id, title: `card ${id}`, status, createdAt: '2026-10-16T10:00:00Z', dependsOn: [] });
const TASKS = [task('OPEN-1', 'todo'), task('BUSY-1', 'doing'), task('DONE-1', 'done'), task('DONE-2', 'done'), task('DONE-3', 'done')];
const cards = M.reviewCards(TASKS, new Map(), {});

/** A Storage stand-in; `throws` makes every call throw (blocked site data, a private window). */
function fakeStorage(init = {}, throws = false) {
  const m = new Map(Object.entries(init));
  const guard = () => { if (throws) throw new Error('SecurityError: storage blocked'); };
  return {
    map: m,
    getItem: (k) => { guard(); return m.has(k) ? m.get(k) : null; },
    setItem: (k, v) => { guard(); m.set(k, String(v)); },
    removeItem: (k) => { guard(); m.delete(k); }
  };
}

/** Render the view with `storage` as the renderer's localStorage. */
function render(storage, props = {}) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  try {
    return renderToStaticMarkup(React.createElement(CardsView, { cards, now: NOW, ...props }));
  } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had); else delete globalThis.localStorage;
  }
}
const shownIds = (html) => [...html.matchAll(/data-card="([^"]+)"/g)].map((m) => m[1]);
const toggle = (html) => /<button[^>]*class="cth-cards-done-toggle"[^>]*>([^<]*)<\/button>/.exec(html);

test('default: done cards hidden; a visible SHOW DONE (3) toggle button, not pressed; no checkbox', () => {
  const html = render(fakeStorage());
  assert.deepEqual(shownIds(html).sort(), ['BUSY-1', 'OPEN-1']);
  const t = toggle(html);
  assert.ok(t, 'a toggle button with its own class');
  assert.equal(t[1], 'SHOW DONE (3)');
  assert.match(t[0], /aria-pressed="false"/);
  assert.doesNotMatch(html, /type="checkbox"/, 'the 1.1.90 checkbox is gone');
  assert.match(html, /2 of 5 cards/);
});

test('remembered per viewer: a stored "shown" choice opens the tab with done cards and HIDE DONE (3)', () => {
  const html = render(fakeStorage({ [M.SHOW_DONE_KEY]: '1' }));
  assert.deepEqual(shownIds(html).sort(), ['BUSY-1', 'DONE-1', 'DONE-2', 'DONE-3', 'OPEN-1']);
  const t = toggle(html);
  assert.equal(t[1], 'HIDE DONE (3)');
  assert.match(t[0], /aria-pressed="true"/);
  // a stored "hidden" choice, or anything else, is hidden
  for (const v of ['0', '', 'true', 'yes']) assert.deepEqual(shownIds(render(fakeStorage({ [M.SHOW_DONE_KEY]: v }))).sort(), ['BUSY-1', 'OPEN-1'], v);
});

test('the key carries the cth. prefix, so the fresh-home reset (SettingsModal clearLocalState) clears it', () => {
  assert.match(M.SHOW_DONE_KEY, /^cth\./);
  assert.match(codeOnly(readSource('src/renderer/src/components/SettingsModal.tsx')), /k\.startsWith\('cth\.'\)/);
});

test('load/save: round trip; a missing or throwing storage reads hidden and never throws', () => {
  const s = fakeStorage();
  assert.equal(M.loadShowDone(s), false);
  M.saveShowDone(true, s);
  assert.equal(s.map.get(M.SHOW_DONE_KEY), '1');
  assert.equal(M.loadShowDone(s), true);
  M.saveShowDone(false, s);
  assert.equal(s.map.get(M.SHOW_DONE_KEY), '0');
  assert.equal(M.loadShowDone(s), false);
  const bad = fakeStorage({}, true);
  assert.equal(M.loadShowDone(bad), false);
  assert.doesNotThrow(() => M.saveShowDone(true, bad));
  assert.equal(M.loadShowDone(null), false);
  assert.doesNotThrow(() => M.saveShowDone(true, null));
  // the localStorage accessor itself throwing (blocked site data) still reads hidden
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('SecurityError'); }, configurable: true });
  try {
    assert.equal(M.loadShowDone(), false);
    assert.doesNotThrow(() => M.saveShowDone(true));
  } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had); else delete globalThis.localStorage;
  }
  // a throwing storage still renders the default view
  assert.deepEqual(shownIds(render(fakeStorage({}, true))).sort(), ['BUSY-1', 'OPEN-1']);
});

test('an explicit initialFilter (tests, the shot) wins over the stored choice', () => {
  const html = render(fakeStorage({ [M.SHOW_DONE_KEY]: '1' }), { initialFilter: M.DEFAULT_FILTER });
  assert.deepEqual(shownIds(html).sort(), ['BUSY-1', 'OPEN-1']);
});

test('all done and hidden: the empty message names the toggle', () => {
  const html = renderToStaticMarkup(React.createElement(CardsView, { cards: cards.filter((c) => c.status === 'done'), now: NOW, initialFilter: M.DEFAULT_FILTER }));
  assert.match(html, /No card matches\. Done cards are hidden: press SHOW DONE to include them\./);
});

test('wiring: the toggle saves the choice on click (source pin on CardsView)', () => {
  const src = codeOnly(readSource('src/renderer/src/components/CardsView.tsx'));
  assert.match(src, /className="cth-cards-done-toggle"[\s\S]{0,400}onClick=\{\(\) => \{[^\n]*saveShowDone\(/);
});
