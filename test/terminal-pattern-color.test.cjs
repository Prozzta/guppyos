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

test('TERM-SHA-WORDBOUND-107: a sha is never the tail or head of a longer word', () => {
  const shas = (value) => texts(value).filter((_, index) => kinds(value)[index] === 'sha');
  // Between backslashes (a Windows path fragment with no drive) the sha still colours, alone.
  assert.deepEqual(shas('Temp\\claude\\eb75033b6603bfd5\\x'), ['eb75033b6603bfd5']);
  // Glued to a word on the left: the old lookbehind let 'deeb75033b' start inside 'claude'.
  assert.deepEqual(shas('claudeeb75033b'), []);
  assert.deepEqual(shas('Temp\\claudeeb75033b6603bfd5'), []);
  // Right side, and underscore/digit/dash on either side.
  assert.deepEqual(shas('eb75033bzz'), []);
  assert.deepEqual(shas('x_eb75033b eb75033b_x 9-eb75033b eb75033b-9'), []);
  // Ordinary boundaries keep working.
  assert.deepEqual(shas('merged f92d798e (66e79e30) "f92d798e" /f92d798e/ f92d798e, 66e79e30.'), ['f92d798e', '66e79e30', 'f92d798e', 'f92d798e', 'f92d798e', '66e79e30']);
});

test('TERM-PATH-EXT-107: relative paths colour whole, bare names only with a listed extension', () => {
  const paths = (value) => texts(value).filter((_, index) => kinds(value)[index] === 'path');
  const tmp = '..\\..\\Users\\FiercePC\\AppData\\Local\\Temp\\claudeeb75033b6603bfd5\\ffcd5ff4-a79d-4910-9156-c845f8e9a92a\\';
  // The Human's real history (mockup): each path coloured whole, from '..' to the extension, once.
  assert.deepEqual(paths(`  ⎿ Referenced file ${tmp}scratchpad\\rust-agent-harnesses.html`), [`${tmp}scratchpad\\rust-agent-harnesses.html`]);
  assert.deepEqual(paths(`Read ${tmp}tasks\\bvnfa1owy.output (4 lines)`), [`${tmp}tasks\\bvnfa1owy.output`]);
  assert.deepEqual(paths(`  ⎿ Read ${tmp}scratchpad\\guppy-terminal-colours.html (109 lines)`), [`${tmp}scratchpad\\guppy-terminal-colours.html`]);
  assert.deepEqual(paths('Referenced file agents\\sele-mvid7p74\\research\\RUST-AGENT-HARNESSES.md'), ['agents\\sele-mvid7p74\\research\\RUST-AGENT-HARNESSES.md']);
  assert.deepEqual(paths('Referenced file PROTOCOL.md'), ['PROTOCOL.md']);
  // Bare names: domains, framework names, abbreviations and sizes stay plain.
  for (const plain of ['github.com', 'guppyos.com is updated', 'Node.js', 'node.js', 'built with Vue.js and D3.JS', 'e.g. this', 'Received 496.4KB (200 OK)', 'x=a.md']) {
    assert.deepEqual(paths(plain), [], plain);
  }
  // A slash or backslash makes any extension a path, exceptions included.
  assert.deepEqual(paths('see src/node.js and lib\\data.weird'), ['src/node.js', 'lib\\data.weird']);
  // Optional :line:col; sentence punctuation and brackets are not part of the path.
  assert.deepEqual(paths('at src/app.ts:12:3, then (test/x.test.cjs). Done: README.md.'), ['src/app.ts:12:3', 'test/x.test.cjs', 'README.md']);
  // Drive paths, POSIX paths and URLs are neither split nor coloured twice: what the painter keeps
  // (first, outermost; the highlighter's own overlap rule) is each whole token once.
  const painted = (value) => {
    const kept = [];
    for (const m of findTerminalPatterns(value)) if (!kept.some((k) => m.start < k.end && k.start < m.end)) kept.push(m);
    return kept.filter((m) => m.kind === 'path' || m.kind === 'URL').map((m) => `${m.kind}:${m.text}`);
  };
  const mixed = 'C:\\Program Files\\Guppy\\Guppy.exe and /srv/app/main.py:8 and https://claude.ai/artifact/SUmphoGPzwgQAUgDUAVZ55 and https://x.test/a/b.md';
  assert.deepEqual(painted(mixed), ['path:C:\\Program Files\\Guppy\\Guppy.exe', 'path:/srv/app/main.py:8', 'URL:https://claude.ai/artifact/SUmphoGPzwgQAUgDUAVZ55', 'URL:https://x.test/a/b.md']);
  // The relative rule itself never adds a span overlapping a URL or a drive/POSIX path.
  assert.deepEqual(paths(mixed).filter((p) => !p.startsWith('C:') && !p.startsWith('/srv') && !p.startsWith('//')), []);
});

test('TERM-PATH-EXT-107 audit cases: case, dot-first, partial overlap, drive suffix, numbers', () => {
  const paths = (value) => texts(value).filter((_, index) => kinds(value)[index] === 'path');
  // S1: the bare-name extension lookup is case-insensitive.
  assert.deepEqual(paths('see README.MD and SETUP.PS1'), ['README.MD', 'SETUP.PS1']);
  // S2: a token that starts with the dot has no name, so it is not a path.
  for (const plain of ['.md files', 'see .env']) assert.deepEqual(paths(plain), [], plain);
  // S3: a span that only partly overlaps a URL is skipped, not just one the URL contains.
  const glued = 'abc/https://x.io/a.md';
  assert.ok(!paths(glued).includes(glued), paths(glued).join(' | '));
  // S4: the drive rule takes the VS Code suffixes too, so a spaced drive path stays whole.
  assert.deepEqual(paths('at C:\\Program Files\\a.ts(339,12) now'), ['C:\\Program Files\\a.ts(339,12)']);
  assert.deepEqual(paths('at C:\\x\\a.ts(339, 12) now'), ['C:\\x\\a.ts(339, 12)']);
  // S5: an extension needs a letter, so fractions and numbers after a slash stay plain.
  for (const plain of ['50/50.5', 'v1/2.0', '3/4.5 cups']) assert.deepEqual(paths(plain), [], plain);
});

test('TERM-PATH-EXT-107: line/column suffix forms ported from VS Code colour with the path', () => {
  const paths = (value) => texts(value).filter((_, index) => kinds(value)[index] === 'path');
  for (const suffix of [':339', ':339:12', ':339:12-789', ':339:12-341.789', ':339.12', '#339', '#339:12',
    '(339)', '(339,12)', '(339, 12)', '(339:12)', ':(339)', '[339]', '[339,12]', '[339, 12]']) {
    assert.deepEqual(paths(`at src/app.ts${suffix} now`), [`src/app.ts${suffix}`], suffix);
    assert.deepEqual(paths(`at PROTOCOL.md${suffix}.`), [`PROTOCOL.md${suffix}`], suffix);
  }
  assert.deepEqual(paths('C:\\w\\app.ts(12,3) and C:\\w\\b.ts:4:2-9 and /srv/app/main.py(8, 2) and /srv/x.rs#7'),
    ['C:\\w\\app.ts(12,3)', 'C:\\w\\b.ts:4:2-9', '/srv/app/main.py(8, 2)', '/srv/x.rs#7']);
  // The prose-shaped VS Code forms are deliberately not ported.
  assert.deepEqual(paths('PROTOCOL.md 339, src/a.ts, 12 more, Read x/y.output (4 lines), "z/q.md", line 3'), ['PROTOCOL.md', 'src/a.ts', 'x/y.output', 'z/q.md']);
});

test('TERM-PATH-EXT-107: bare-name extensions come from the vendored lists minus TLDs', () => {
  const { TERMINAL_PATH_EXTENSIONS, TERMINAL_PATH_EXCEPTIONS, TERMINAL_PATH_TLD_FILE_CLASHES } = loadTs('src/renderer/src/components/terminalPatternColor.ts');
  const { VENDORED_FILE_EXTENSIONS, VENDORED_TLDS } = loadTs('src/renderer/src/components/terminalPathData.ts');
  assert.equal(VENDORED_FILE_EXTENSIONS.length, 594); // text-extensions@3.1.0 (328) + binary-extensions@3.2.0 (271), de-duplicated
  assert.ok(VENDORED_TLDS.length > 1200 && VENDORED_TLDS.includes('com') && VENDORED_TLDS.includes('md'));
  assert.ok(TERMINAL_PATH_EXTENSIONS.size >= 500, `size ${TERMINAL_PATH_EXTENSIONS.size}`);
  for (const ext of ['md', 'ts', 'json', 'yaml', 'toml', 'env', 'lock', 'pdf', 'docx', 'csv', 'scss', 'svg', 'log', 'png', 'exe', 'dll', 'msi', 'asar', 'zip', 'py', 'sh', 'rs']) assert.ok(TERMINAL_PATH_EXTENSIONS.has(ext), ext);
  for (const tld of ['com', 'org', 'net', 'io', 'ai', 'dev', 'app', 'co', 'uk', 'me', 'so', 'gg', 'tv', 'us', 'info', 'biz']) assert.ok(!TERMINAL_PATH_EXTENSIONS.has(tld), tld);
  // Every TLD is out of the bare-name set unless it is a reviewed file clash.
  for (const tld of VENDORED_TLDS) assert.equal(TERMINAL_PATH_EXTENSIONS.has(tld), TERMINAL_PATH_TLD_FILE_CLASHES.has(tld), tld);
  for (const name of ['node.js', 'vue.js', 'next.js', 'nuxt.js', 'react.js', 'express.js', 'three.js', 'chart.js', 'd3.js', 'deno.js']) assert.ok(TERMINAL_PATH_EXCEPTIONS.has(name), name);
  const paths = (value) => texts(value).filter((_, index) => kinds(value)[index] === 'path');
  assert.deepEqual(paths('notes.txt build.zip run.sh lib.rs docs.python.org openai.ai lua.so'), ['notes.txt', 'build.zip', 'run.sh', 'lib.rs']);
});

test('TERM-PATH-EXT-107: a version ending a sentence still colours; a 4-part number does not', () => {
  const versions = (value) => texts(value).filter((_, index) => kinds(value)[index] === 'version');
  assert.deepEqual(versions('one commit for 1.1.107.'), ['1.1.107']);
  assert.deepEqual(versions('1.1.106, then 1.1.107. Next'), ['1.1.106', '1.1.107']);
  assert.deepEqual(versions('clean 1.1.107 branch, 1.1.106 plus'), ['1.1.107', '1.1.106']);
  assert.deepEqual(versions('1.1.107.4 and 1.1.107.x and 1.1.107..'), []);
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
