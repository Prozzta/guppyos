'use strict';
require('./tools/own-job.cjs');
// PTY-CONHOST-LEAK-NATIVE (branch guppy/pty-conhost-leak-native-108): no terminal of the app may
// ever stop reading its output.
//
// WHY. On the bundled console host the host closes a terminal's output only once it has been
// read. A reader that has paused would therefore never get its exit, and the host would stay for
// as long as the app lives (the leak that card fixes). So node-pty's exit path, as patched by
// tools/patch-node-pty-root-handle.cjs, destroys the output of a reader that is paused when the
// program ends or pauses afterwards: what that reader had not taken by then is DROPPED, by design
// (upstream pays the same on the inbox host: its flush timer destroys the output 1 s after the
// exit, read or not). A reader that never pauses loses nothing: that is the cell 'a reader that
// never pauses' in pty-conhost-leak-native.test.cjs.
//
// So the cost is nil for exactly as long as nothing in the app pauses a terminal. This file is
// what keeps it so. Three ways lead to a paused reader, and all three are forbidden:
//   (a) pause() on a pty or on its socket;
//   (b) handleFlowControl set in the spawn options: node-pty then calls pause() itself on XOFF;
//   (c) pipe() of a pty or its socket: a slow destination pauses the source through backpressure.
// If you need one of these, the tail-at-exit drop becomes real and needs a fix first (drain the
// output into the stream at exit instead of destroying it), not a change to this pin.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WHY = 'PTY-CONHOST-LEAK-NATIVE (guppy/pty-conhost-leak-native-108): a terminal whose reader is paused when its program ends loses the unread end of the output on the bundled console host, by design (the host closes the output only once it is read; node-pty\'s patched exit path destroys a paused output so that the exit is still reported and the host goes). Nothing in the app may pause a terminal';

const LOADS_NODE_PTY = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)['"`]node-pty['"`]/;
// A name a pty, or the socket of one, goes by. Used outside the files that load node-pty, where a
// pty can only have arrived under some name; in the loading files every pause() and pipe() counts.
const PTY_NAME = String.raw`(?:proc|pty|ptyProcess|term|terminal|sock|socket|_socket|_outSocket|_inSocket|_agent)`;
// Between the name and the dot: `(proc as Terminal).pause()`, `proc!.pause()`.
const CAST = String.raw`(?:\s+as\s+[\w.<>]+)?\s*(?:\)|!)*\s*`;
const RULES = {
  loader: [
    ['(a) pause()', /(?:\.|\?\.)\s*pause\s*\(/g],
    ['(c) pipe()', /(?:\.|\?\.)\s*pipe\s*\(/g],
  ],
  any: [
    ['(a) pause() on a pty or its socket', new RegExp(String.raw`\b${PTY_NAME}${CAST}(?:\.|\?\.)\s*pause\s*\(`, 'g')],
    ['(c) pipe() on a pty or its socket', new RegExp(String.raw`\b${PTY_NAME}${CAST}(?:\.|\?\.)\s*pipe\s*\(`, 'g')],
    // Anything but an explicit `handleFlowControl: false` counts, a comment included.
    ['(b) handleFlowControl', /\bhandleFlowControl\b(?!['"`]?\s*:\s*false\b)/g],
  ],
};

/** Every place in `text` that could pause a terminal: [rule, line number, the line]. */
function violations(text) {
  const loader = LOADS_NODE_PTY.test(text);
  const found = [];
  const seen = new Set();
  for (const [rule, re] of [...(loader ? RULES.loader : []), ...RULES.any]) {
    for (const m of text.matchAll(re)) {
      const line = text.slice(0, m.index).split('\n').length;
      const key = `${rule[1]}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push([rule, line, text.split('\n')[line - 1].trim()]);
    }
  }
  return found;
}

function sources(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') sources(p, out); }
    else if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const FILES = sources(path.join(ROOT, 'src')).map((p) => [rel(p), fs.readFileSync(p, 'utf8')]);
const LOADERS = FILES.filter(([, text]) => LOADS_NODE_PTY.test(text));
const PTY_TS = 'src/main/pty.ts';

test('PTY-NO-PAUSE-PIN: the scan sees the app\'s sources, and src/main/pty.ts among the files that load node-pty', () => {
  assert.ok(FILES.length > 100, `the scan found the sources: ${FILES.length} files under src/`);
  assert.ok(LOADERS.some(([f]) => f === PTY_TS), `${PTY_TS} loads node-pty and the scan knows it: ${LOADERS.map(([f]) => f).join(', ') || 'no file loads node-pty'}`);
});

test('PTY-NO-PAUSE-PIN: no source file pauses a terminal: no pause() and no pipe() in any file that loads node-pty or on a pty or its socket anywhere, and no handleFlowControl', () => {
  const bad = FILES.flatMap(([f, text]) => violations(text).map(([rule, line, src]) => `${f}:${line}  ${rule}:  ${src}`));
  assert.deepEqual(bad, [], `${WHY}. Found:\n${bad.join('\n')}\n`);
});

// The teeth: the real src/main/pty.ts, with one line added, is caught on each of the three ways.
const ptyTs = () => (FILES.find(([f]) => f === PTY_TS) || [PTY_TS, ''])[1];
const MUTANTS = [
  ['(a) pause() on the pty', 'proc.pause();', '(a)'],
  ['(a) pause() on the pty\'s socket', 't._socket?.pause();', '(a)'],
  ['(a) pause() on anything, in a file that loads node-pty', 'session.reader.pause();', '(a)'],
  ['(b) handleFlowControl set in the spawn options', 'const p = pty.spawn(file, args, { cols, rows, handleFlowControl: true });', '(b)'],
  ['(b) handleFlowControl set from a variable', 'const options = { cols, rows, handleFlowControl };', '(b)'],
  ['(c) pipe() of the pty\'s socket', 't._socket.pipe(destination);', '(c)'],
];
for (const [name, line, rule] of MUTANTS) {
  test(`PTY-NO-PAUSE-PIN teeth: ${name} is caught`, () => {
    const clean = ptyTs();
    assert.deepEqual(violations(clean), [], `${PTY_TS} is clean as it stands`);
    const got = violations(`${clean}\n${line}\n`);
    assert.equal(got.length, 1, `one finding for the one added line \`${line}\`: ${JSON.stringify(got)}`);
    assert.ok(got[0][0].startsWith(rule) && got[0][2] === line, `it is the added line, under rule ${rule}: ${JSON.stringify(got[0])}`);
  });
}

test('PTY-NO-PAUSE-PIN teeth: a pty paused in a file that does NOT load node-pty is caught too, and what is no pause is not', () => {
  const plain = "import { something } from './pty';\n";
  for (const line of ['session.proc.pause();', 'proc?.pause();', '(proc as Terminal).pause();', 'term._socket.pause();', 'agent._outSocket.pipe(log);', 'spawn({ handleFlowControl: on });', "opts['handleFlowControl'] = true;"]) {
    assert.equal(violations(plain + line).length, 1, `caught: ${line}`);
  }
  for (const line of ['control.pause(agentId, true);', 'req.pipe(upstream);', 'pty.spawn(file, args, { handleFlowControl: false });', 'const paused = proc.paused;']) {
    assert.deepEqual(violations(plain + line), [], `not a paused terminal: ${line}`);
  }
});
