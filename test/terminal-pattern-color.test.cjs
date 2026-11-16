'use strict';
require('./tools/own-job.cjs');

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { Terminal: HeadlessTerminal } = require('@xterm/headless');

const {
  TERMINAL_PATTERN_COLOUR_TABLE,
  TerminalPatternHighlighter,
  findTerminalPatterns,
  newlyWrittenLineRange
} = loadTs('src/renderer/src/components/terminalPatternColor.ts');

const kinds = (text, agents) => findTerminalPatterns(text, agents).map((item) => item.kind);
const texts = (text, agents) => findTerminalPatterns(text, agents).map((item) => item.text);

function instrumentedHeadless(options = {}) {
  const term = new HeadlessTerminal({ allowProposedApi: true, cols: 80, rows: 4, scrollback: 6, ...options });
  const decorations = [];
  const renderListeners = [];
  // @xterm/headless deliberately has no browser decoration/render surface. This
  // small adapter preserves its real buffer and markers while recording the
  // browser-only operations the highlighter asks xterm to perform.
  term.onRender = (listener) => {
    renderListeners.push(listener);
    return { dispose() { const i = renderListeners.indexOf(listener); if (i >= 0) renderListeners.splice(i, 1); } };
  };
  term.registerDecoration = (options) => {
    const decorationListeners = [];
    const record = {
      options, marker: options.marker, disposed: false, element: { style: {} },
      onRender(listener) { decorationListeners.push(listener); return { dispose() {} }; },
      render() { decorationListeners.forEach((listener) => listener(this.element)); },
      dispose() { this.disposed = true; }
    };
    decorations.push(record);
    return record;
  };
  return {
    term, decorations,
    render: () => renderListeners.forEach((listener) => listener({ start: 0, end: term.rows - 1 })),
    renderDecorations: () => decorations.filter((item) => !item.disposed).forEach((item) => item.render())
  };
}

const write = (term, value) => new Promise((resolve) => term.write(value, resolve));

test('pattern palette is one complete shipped light/dark table', () => {
  assert.deepEqual(Object.keys(TERMINAL_PATTERN_COLOUR_TABLE), ['path', 'sha', 'PASS', 'FAIL', 'ERROR', 'WARN', 'agent', 'URL', 'version']);
  for (const item of Object.values(TERMINAL_PATTERN_COLOUR_TABLE)) {
    assert.match(item.light, /^#[0-9A-F]{6}$/i);
    assert.match(item.dark, /^#[0-9A-F]{6}$/i);
    assert.ok(['underline', 'colour only'].includes(item.style));
  }
  assert.deepEqual(TERMINAL_PATTERN_COLOUR_TABLE.WARN, { light: '#9C6B00', dark: '#CFAA57', style: 'colour only' });
});

test('Windows and POSIX paths include optional line and column, but prose does not', () => {
  const value = 'C:\\work\\app.ts:12:3, C:\\Program Files\\Guppy\\Guppy.exe and /srv/app/main.py:8 and /var/log/syslog';
  assert.deepEqual(texts(value).filter((_, index) => kinds(value)[index] === 'path'), ['C:\\work\\app.ts:12:3', 'C:\\Program Files\\Guppy\\Guppy.exe', '/srv/app/main.py:8', '/var/log/syslog']);
  assert.ok(!kinds('C: notes, / and a/b and /clear').includes('path'));
});

test('git SHA recognition is bounded and never colours a plain number', () => {
  assert.deepEqual(texts('commit deadbeef and 0123456789').filter((_, index) => kinds('commit deadbeef and 0123456789')[index] === 'sha'), ['deadbeef']);
  assert.ok(!kinds('build 1234567890 and 123456 and defaced and 550e8400-e29b').includes('sha'));
});

test('status words and error lines have deliberate positive and negative matches', () => {
  assert.deepEqual(kinds('PASS FAIL ERROR WARN WARNING'), ['PASS', 'FAIL', 'ERROR', 'WARN', 'WARN']);
  assert.ok(!kinds('PASSING warnings ERRORLESS').some((kind) => ['PASS', 'FAIL', 'ERROR', 'WARN'].includes(kind)));
  assert.ok(kinds('fatal: unable to connect').includes('ERROR'));
  assert.ok(!kinds('completed with 0 errors').includes('ERROR'));
});

test('live roster names are word-bounded', () => {
  assert.deepEqual(texts('Dwight coordinated with UHera.', ['Dwight', 'UHera']).filter((_, index) => kinds('Dwight coordinated with UHera.', ['Dwight', 'UHera'])[index] === 'agent'), ['Dwight', 'UHera']);
  assert.ok(!kinds('Dwightish and thank god it worked', ['Dwight', 'God']).includes('agent'));
});

test('URLs and semantic versions recognise safe forms only', () => {
  assert.ok(kinds('see https://example.test/a and http://localhost:3000').filter((kind) => kind === 'URL').length === 2);
  assert.ok(!kinds('ftp://example.test and example.test').includes('URL'));
  assert.deepEqual(texts('released v1.1.106 and 2.3.4').filter((_, index) => kinds('released v1.1.106 and 2.3.4')[index] === 'version'), ['v1.1.106', '2.3.4']);
  assert.ok(!kinds('version 1.1 and 1.1.1060x').includes('version'));
});

test('range helper describes a real cursor position in the retained buffer', () => {
  assert.deepEqual(newlyWrittenLineRange(1_019, 1_000, 23), { start: 1_019, end: 1_023 });
  assert.deepEqual(newlyWrittenLineRange(-1, 50_000, 23), { start: 50_000, end: 50_023 });
});

test('headless xterm keeps scanning after scrollback trims without repainting the viewport', async () => {
  const { term, decorations, render } = instrumentedHeadless();
  const highlighter = new TerminalPatternHighlighter(term, { background: '#1A1A1F' });
  for (let i = 0; i < 30; i++) {
    await write(term, `line ${i} deadbeef PASS\r\n`);
    highlighter.scanNewOutput();
    render();
  }
  const createdBeforeSteadyState = decorations.length;
  for (let i = 30; i < 38; i++) {
    await write(term, `line ${i} deadbeef PASS\r\n`);
    highlighter.scanNewOutput();
    render();
  }
  // Each new line has two matches. Permit one re-read of the partial cursor
  // line, but never a full visible viewport's worth of registrations.
  assert.ok(decorations.length - createdBeforeSteadyState <= 20,
    'post-trim frames only create decorations for newly written matches');
  const active = decorations.filter((item) => !item.disposed);
  assert.ok(active.some((item) => term.buffer.active.getLine(item.marker.line)?.translateToString(true).includes('line 37')),
    'the final retained line has a decoration after the scrollback has trimmed');
  highlighter.dispose();
});

test('headless cursor-up rewrite removes stale decorations from the redrawn row', async () => {
  const { term, decorations, render } = instrumentedHeadless();
  const highlighter = new TerminalPatternHighlighter(term, { background: '#FCFAF0' });
  await write(term, 'a ok\r\nb FAIL\r\nc done');
  highlighter.scanNewOutput();
  await write(term, '\x1b[1A\r\x1b[2Kb ok now');
  highlighter.scanNewOutput();
  render();
  assert.ok(!decorations.filter((item) => !item.disposed).some((item) =>
    term.buffer.active.getLine(item.marker.line)?.translateToString(true).includes('b ok now')),
  'the old FAIL decoration is disposed after a cursor-up redraw');
  highlighter.dispose();
});

test('headless wide characters map string offsets to xterm cell positions', async () => {
  const { term, decorations } = instrumentedHeadless();
  const highlighter = new TerminalPatternHighlighter(term, { background: '#FCFAF0' });
  await write(term, '✅ 中文 PASS deadbeef');
  highlighter.scanNewOutput();
  const line = term.buffer.active.getLine(0);
  const cellOf = (glyph) => {
    for (let x = 0; x < line.length; x++) if (line.getCell(x)?.getChars() === glyph) return x;
    return -1;
  };
  const active = decorations.filter((item) => !item.disposed);
  assert.equal(active.find((item) => item.options.foregroundColor === '#20904B')?.options.x, cellOf('P'));
  assert.equal(active.find((item) => item.options.foregroundColor === '#8A5CF0')?.options.x, cellOf('d'));
  highlighter.dispose();
});

test('underline styles render and a theme switch repaints the visible rows', async () => {
  const { term, decorations, renderDecorations } = instrumentedHeadless();
  const highlighter = new TerminalPatternHighlighter(term, { background: '#FCFAF0' });
  await write(term, '/srv/app/main.ts https://example.test');
  highlighter.scanNewOutput();
  renderDecorations();
  const light = decorations.filter((item) => !item.disposed);
  assert.equal(light.find((item) => item.options.foregroundColor === '#2B6CB0')?.element.style.textDecoration, 'underline');
  assert.equal(light.find((item) => item.options.foregroundColor === '#3B7DC4')?.element.style.textDecoration, 'underline');
  highlighter.setPalette({ background: '#1A1A1F' });
  const dark = decorations.filter((item) => !item.disposed);
  assert.ok(light.every((item) => item.disposed), 'the old-theme decorations are removed');
  assert.ok(dark.some((item) => item.options.foregroundColor === '#6FB3C4'));
  highlighter.dispose();
});
