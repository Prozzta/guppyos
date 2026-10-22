'use strict';
/**
 * GOD-TERMINAL-CONTROL M1 (design agents/andy-mtuk4y4x/GOD-TERMINAL-CONTROL-DESIGN.md, section 8;
 * Jim's review 16:23Z folded in): main's headless mirror per PTY, the god-only `term` channel
 * (read / type / keys / send), origin GOD, the shadow diff, and the mirror's cost bar.
 *
 * HOME IS REDIRECTED AND ASSERTED before any hive is built.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'gtc-193-'));
const realEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME redirect failed - aborting before constructing any hive');
test.after(() => {
  for (const [k, v] of Object.entries(realEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const M = loadTs('src/main/terminalMirror.ts');
const T = loadTs('src/main/termControl.ts');
const SHARED = loadTs('src/shared/codexScreen.ts');
const TUI = loadTs('src/shared/tuiComposer.ts');
const PA = loadTs('src/shared/providerAutomation.ts');
const SH = loadTs('src/main/termShadow.ts');
const COST = loadTs('src/main/mirrorCost.ts');
const { PtyManager } = loadTs('src/main/pty.ts');
const OWN = loadTs('src/main/automaticSubmit.ts');
const { ADMISSION_REASON } = loadTs('src/main/capacityAdmission.ts');

// ─── 1. the mirror ───────────────────────────────────────────────────────────────────────

test('mirror: the screen and cursor after every byte, unicode 11 widths, modes from the stream', async () => {
  const m = M.createTerminalMirror(40, 6);
  m.write('\x1b[?2004h\x1b[1mhello\x1b[0m\r\n❯ 中文x');
  const r = await m.read();
  assert.equal(r.lines[0], 'hello');
  assert.equal(r.lines[1], '❯ 中文x');
  assert.deepEqual(r.cursor, { x: 7, y: 1 }, 'the two wide glyphs take two cells each');
  assert.equal(r.bracketedPaste, true);
  assert.equal(r.appCursor, false);
  m.write('\x1b[?1h\x1b[?1049h');
  const alt = await m.read(2);
  assert.equal(alt.altScreen, true);
  assert.equal(alt.appCursor, true);
  assert.equal(alt.lines.length, 2, '--rows N = the last N rows');
  assert.equal(m.bytesWritten(), '\x1b[?2004h\x1b[1mhello\x1b[0m\r\n❯ 中文x'.length + '\x1b[?1h\x1b[?1049h'.length);
  m.resize(20, 4);
  assert.equal((await m.read()).cols, 20);
  m.dispose();
  m.write('ignored after dispose');
});

test('mirror NEVER answers the TUI: a DA/CPR query reaches no onData (headless would reply ESC[?1;2c)', async () => {
  // The drop is load-bearing (a second answer would reach the child as typed input): nothing may
  // even subscribe to the headless terminal's onData.
  const touched = [];
  const make = (c, r) => new Proxy(M.createHeadless(c, r), {
    get(target, prop, recv) {
      if (prop === 'onData' || prop === 'onBinary') touched.push(prop);
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    }
  });
  const m = M.createTerminalMirror(80, 24, make);
  m.write('\x1b[c\x1b[6n\x1b[5n');
  await m.read();
  m.dispose();
  assert.deepEqual(touched, [], 'onData/onBinary never touched');
  assert.doesNotMatch(src('src/main/terminalMirror.ts').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /onData|onBinary/);
});

test('PtyManager: deliverData feeds the mirror after the identity guard; a replaced session reads null; GOD is wired', async () => {
  const pm = new PtyManager();
  pm.setMirrorFactory((c, r) => M.createTerminalMirror(c, r));
  const mk = (id) => ({ id, cwd: '', command: '', owner: null, lastOutputAt: 0, hasOutput: false, humanInputGeneration: 0, tail: '',
    mirror: M.createTerminalMirror(80, 5), proc: { write: () => {} } });
  const s1 = mk('p1');
  pm.sessions.set('p1', s1);
  pm.deliverData('p1', s1, 'abc');
  const stale = mk('p1');
  pm.deliverData('p1', stale, 'NOT-OURS');   // not the live session: dropped before the mirror
  assert.equal((await pm.readScreen('p1')).lines[0], 'abc');
  assert.equal(pm.mirrorBytes(), 3);
  const reading = pm.readScreen('p1');
  pm.sessions.set('p1', stale);   // replaced while the read drains
  assert.equal(await reading, null, 'a reading of a replaced session is not evidence');
  assert.equal(await pm.readScreen('nope'), null);
  pm.sessions.delete('p1');
  assert.equal(pm.mirrorBytes(), 3, 'monotonic: an ended session keeps its count in');
  // The spawn makes the mirror, deliverData feeds it, resize keeps the geometry, reportEnd disposes.
  const pty = src('src/main/pty.ts');
  assert.match(pty, /if \(this\.sessions\.get\(id\) !== session\) return;[\s\S]{0,1400}session\.mirror\.write\(data\)/);
  assert.match(pty, /session\.mirror = this\.mirrorFactory\(proc\.cols, proc\.rows\)/);
  assert.match(pty, /s\.mirror\?\.resize\(cols, rows\)/);
  s1.mirror.dispose(); stale.mirror.dispose();
});

// ─── 2. the shadow diff: the mirror reads the live rows that broke us as the renderer did ──

const FX = path.join(__dirname, 'fixtures', 'tui-composer-allowlist');
const WSG = path.join(__dirname, 'fixtures', 'wake-screen-guard');
const fixture = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
const plainFacts = (lines, cursorRow) => SHARED.extractCodexScreen((i) => lines[i], lines.length, cursorRow);
const RULE192 = '─'.repeat(194);
const DRAFT192 = 'You have new hive mail (delivered in context below): 2026-10-18T14-50-00-948Z-2babeb.';
const FOOTER192 = [RULE192, 'ctx 121k/1000k (12%)', '⏵⏵ bypass permissions on (shift+tab to cycle)'];
/** The 1.1.93 help panel (a lone "?" through ConPTY, measured 16:30Z, Claude 2.1.302), as the probe read it. */
const HELP193 = [
  '─'.repeat(120),
  '❯ Try "fix typecheck errors"',
  '─'.repeat(120),
  '  ! for shell mode        double tap esc to clear input      ctrl + shift + _ to undo',
  '  / for commands          shift + tab to auto-accept edits   alt + v to paste images',
  '  @ for file paths        ctrl + o for verbose output        alt + p to switch model',
  '  /btw for side question  ctrl + t to toggle tasks           ctrl + s to stash prompt',
  '                          backslash (\\) + return (⏎) for     ctrl + g to edit in $EDITOR',
  '                          newline                            /keybindings to customize'
];

/** Draws `lines` into a fresh mirror as a TUI would (colour, absolute moves), cursor at the end of `cursorRow`. */
async function mirrorFacts(lines, cursorRow, cols) {
  const m = M.createTerminalMirror(cols, lines.length);
  let bytes = '\x1b[H\x1b[2J';
  lines.forEach((l, i) => { bytes += `\x1b[${i + 1};1H\x1b[38;5;${100 + (i % 50)}m${l.replace(/^(❯ )(Try .*)$/, '$1\x1b[2m$2\x1b[22m')}\x1b[0m`; });
  bytes += `\x1b[${cursorRow + 1};${Math.min(cols, lines[cursorRow].length + 1)}H`;
  m.write(bytes);
  const f = await m.facts();
  m.dispose();
  return f;
}

const SHADOW_CASES = [
  { name: '1.1.92 STAGE "❯" (no separator)', provider: 'claude', lines: ['● Done: the card is closed.', '', RULE192, '❯', ...FOOTER192], cursorRow: 3, cols: 200, cls: 'READY' },
  { name: '1.1.92 COMMIT "❯You have…" (no separator)', provider: 'claude', lines: ['● Done: the card is closed.', '', RULE192, `❯${DRAFT192}`, ...FOOTER192], cursorRow: 3, cols: 200 },
  { name: '1.1.93 help panel under the box', provider: 'claude', lines: HELP193, cursorRow: 1, cols: 120 },
  ...['claude-hive-statusline-idle', 'claude-hive-statusline-boot'].map((n) => {
    const fx = fixture(FX, n);
    return { name: `${n} (ctx gauge footer)`, provider: 'claude', lines: fx.lines, cursorRow: fx.cursorRow, cols: fx.cols, cls: 'READY' };
  }),
  ...['2-trusted-idle-80x24', '1-untrusted-trust-80x24'].map((n) => {
    const fx = fixture(WSG, n);
    return { name: `codex ${n}`, provider: 'codex', lines: fx.lines, cursorRow: fx.cursorRow, cols: fx.cols };
  })
];

for (const c of SHADOW_CASES) {
  test(`shadow pin: the mirror reads ${c.name} exactly as the renderer's extractor does, and the gate classes it the same`, async () => {
    const want = plainFacts(c.lines, c.cursorRow);
    const got = await mirrorFacts(c.lines, c.cursorRow, c.cols);
    assert.deepEqual(SH.factsDiff(want, got), [], `fields differ: ${JSON.stringify({ want, got })}`);
    assert.equal(SH.gateClass(c.provider, got), SH.gateClass(c.provider, want));
    if (c.cls) assert.equal(SH.gateClass(c.provider, got), c.cls);
  });
}

test('shadow: the 1.1.93 help panel is NOT a ready composer on either side', async () => {
  assert.notEqual(SH.gateClass('claude', await mirrorFacts(HELP193, 1, 120)), 'READY');
});

test('ShadowDiff: moving readings never count as disagreement; disagreement rows are rate-limited and bounded; a summary', () => {
  let t = 0;
  const rows = [];
  const d = new SH.ShadowDiff((r) => rows.push(r), () => t);
  // GTC M2: a sample names its reading kind and the host that answered; both readings are whole.
  const a = { onPromptRow: false, screenCount: 0, codex: plainFacts(['x', '❯'], 1) };
  const b = { onPromptRow: false, screenCount: 0, codex: plainFacts(['x', '❯ typed'], 1) };
  const s = (renderer, mirror, still) => ({ agentId: 'a1', ptyId: 'p', provider: 'claude', kind: 'codex', answeredBy: 'renderer', renderer, mirror, still });
  assert.equal(d.record(s(a, b, false)), 'moving');
  assert.equal(rows.length, 0);
  assert.equal(d.record(s(a, a, true)), 'agree');
  assert.equal(d.record(s(a, b, true)), 'disagree');
  assert.equal(d.record(s(a, b, true)), 'disagree');
  assert.equal(rows.length, 1, 'one row per PTY per gap');
  assert.equal(rows[0].kind, 'term-shadow');
  assert.equal(rows[0].reading, 'codex');
  assert.equal(rows[0].answeredBy, 'renderer');
  assert.ok(rows[0].fields.includes('cursorRow'));
  assert.deepEqual(Object.keys(rows[0].renderer).sort(), [...new Set([...rows[0].fields.filter((k) => k !== 'class'), 'cursorRow', 'tail'])].sort(), 'only the differing fields are logged, and the tail to judge them by');
  t = SH.SHADOW_ROW_GAP_MS;
  d.record(s(a, b, true));
  assert.equal(rows.length, 2);
  t = SH.SHADOW_SUMMARY_MS;
  d.record(s(a, a, true));
  const counts = { agree: 2, disagree: 3, moving: 1, rendererNull: 0, mirrorNull: 0, bothNull: 0 };
  assert.deepEqual(rows.at(-1), { kind: 'term-shadow-summary', ...counts, by: { 'codex/claude': counts } });
});

test('shadow wiring: both readings go through the source-aware gate (GTC M2; test/gtc-m2-196 runs it)', () => {
  const idx = src('src/main/index.ts');
  assert.match(idx, /requestScreenReading: \(ptyId, needle, expectedTail\) => screenGate\.needle\(ptyId, needle, expectedTail\),/);
  assert.match(idx, /requestCodexScreen: \(ptyId, expectedTail\) => screenGate\.codex\(ptyId, expectedTail\),/);
  assert.match(idx, /generation: \(ptyId\) => ptyManager\.outputGeneration\(ptyId\),/);
  assert.match(idx, /record: \(sample\) => termShadow\.record\(sample\),/);
});

// ─── 3. TermControl ──────────────────────────────────────────────────────────────────────

function rig(over = {}) {
  const r = { t: 1_000, gen: 0, god: 'god', writes: [], logs: [], provider: 'claude', noMirror: false, writeFails: null,
    screen: { lines: ['', '❯ ', ''], cursor: { x: 2, y: 1 }, cols: 80, rows: 3, altScreen: false, bracketedPaste: true, appCursor: false }, ...over };
  r.deps = {
    godId: () => r.god,
    ptyOf: (a) => ({ a1: 'p-a1', a2: 'p-a2', god: 'p-god' })[a],
    providerOf: () => r.provider,
    readScreen: async () => (r.noMirror ? null : { ...r.screen, lines: [...r.screen.lines] }),
    write: (ptyId, data) => {
      if (r.writeFails && r.writeFails(data)) return { ok: false, error: 'pipe closed' };
      r.writes.push({ ptyId, data, at: r.t });
      r.gen += 1;
      return { ok: true };
    },
    outputGeneration: () => r.gen,
    log: (row) => r.logs.push(row),
    now: () => r.t,
    sleep: async (ms) => { r.t += ms; }
  };
  r.tc = new T.TermControl(r.deps);
  return r;
}

test('term is god-only, checked at REQUEST time: a non-god caller and the OLD god after a change get 403', async () => {
  const r = rig();
  assert.equal((await r.tc.handle('a2', { action: 'read', agent: 'a1' })).status, 403);
  assert.equal((await r.tc.handle('god', { action: 'read', agent: 'a1' })).status, 200);
  r.god = 'god2';
  const old = await r.tc.handle('god', { action: 'send', agent: 'a1', text: 'hi' });
  assert.equal(old.status, 403, 'the registry god NOW decides, not the god at spawn');
  r.god = null;
  assert.equal((await r.tc.handle('god', { action: 'read', agent: 'a1' })).status, 403, 'no god registered: nobody');
  assert.deepEqual(r.writes, []);
  assert.ok(r.logs.filter((l) => l.ok === false).every((l) => l.kind === 'term' && /god-only/.test(l.error)), 'every refusal is logged');
});

test('term refusals: bad action, no agent, self-target, no live terminal, no mirror', async () => {
  const r = rig();
  assert.equal((await r.tc.handle('god', { action: 'erase', agent: 'a1' })).status, 400);
  assert.equal((await r.tc.handle('god', { action: 'read' })).status, 400);
  assert.equal((await r.tc.handle('god', { action: 'send', agent: 'god', text: 'x' })).status, 400, 'god cannot drive its own terminal');
  assert.equal((await r.tc.handle('god', { action: 'read', agent: 'ghost' })).status, 404);
  r.noMirror = true;
  const nm = await r.tc.handle('god', { action: 'read', agent: 'a1' });
  assert.equal(nm.status, 503);
  assert.match(nm.body.line, /no screen mirror/);
  assert.deepEqual(r.writes, []);
});

test('term read: the screen rows and a header with the cursor and modes', async () => {
  const r = rig();
  const out = await r.tc.handle('god', { action: 'read', agent: 'a1', rows: 2 });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.screen, ['', '❯ ', '']);
  assert.match(out.body.header, /^cursor 2,1 {2}80x3 {2}paste2004=on$/);
  assert.deepEqual(r.writes, [], 'a read writes nothing');
});

test('keyBytes: the named table, SS3 arrows under DECCKM, unknown names refused', () => {
  assert.equal(T.keyBytes('enter', false), '\r');
  assert.equal(T.keyBytes('esc', false), '\x1b');
  assert.equal(T.keyBytes('ctrl-c', false), '\x03');
  assert.equal(T.keyBytes('shift-tab', false), '\x1b[Z');
  assert.equal(T.keyBytes('up', false), '\x1b[A');
  assert.equal(T.keyBytes('up', true), '\x1bOA');
  assert.equal(T.keyBytes('down', true), '\x1bOB');
  assert.equal(T.keyBytes('1', false), '1');
  assert.equal(T.keyBytes('y', false), 'y');
  for (const bad of ['ENTER', 'ctrl-z', 'alt-x', 'q', '', '12']) assert.equal(T.keyBytes(bad, false), null, bad);
});

test('term keys: one write per key with a gap between, DECCKM read from the screen; unknown keys write nothing', async () => {
  const r = rig();
  r.screen.appCursor = true;
  const out = await r.tc.handle('god', { action: 'keys', agent: 'a1', keys: ['down', 'down', 'enter'] });
  assert.equal(out.status, 200, out.body.line);
  assert.deepEqual(r.writes.map((w) => w.data), ['\x1bOB', '\x1bOB', '\r']);
  assert.equal(r.writes[1].at - r.writes[0].at, T.TERM_KEY_GAP_MS);
  assert.deepEqual(r.writes.map((w) => w.ptyId), ['p-a1', 'p-a1', 'p-a1']);
  const before = r.writes.length;
  assert.equal((await r.tc.handle('god', { action: 'keys', agent: 'a1', keys: ['esc', 'ctrl-z'] })).status, 400);
  assert.equal((await r.tc.handle('god', { action: 'keys', agent: 'a1', keys: [] })).status, 400);
  assert.equal((await r.tc.handle('god', { action: 'keys', agent: 'a1', keys: Array(T.TERM_KEYS_MAX + 1).fill('esc') })).status, 400);
  assert.equal(r.writes.length, before, 'a refused key list writes nothing at all');
});

test('checkText: one raw write; escapes stripped whole; C0 refused except TAB/LF; the ?/!/ keys refused unless raw', () => {
  assert.deepEqual(T.checkText('hello world', 'claude', false), { ok: true, text: 'hello world', strippedEscapes: 0 });
  assert.deepEqual(T.checkText('a\x1b[201~b\x1b]0;t\x07c\x1bxd\x1b', 'claude', false), { ok: true, text: 'abcd', strippedEscapes: 4 });
  assert.equal(T.checkText('a\r\nb', 'claude', false).text, 'a\nb');
  assert.equal(T.checkText('a\tb', 'codex', false).ok, true);
  for (const c of ['\x03', '\x04', '\x1a', '\x7f', '\r', '\x00', '\x85', '\x9b']) assert.equal(T.checkText(`a${c}b`, 'claude', true).ok, false, JSON.stringify(c));
  for (const lead of ['?', ' ? ', '!ls', '/clear', '?hello', '? hi', `?${'x'.repeat(4200)}`]) {
    assert.equal(T.checkText(lead, 'claude', false).ok, false, lead.slice(0, 12));
    assert.equal(T.checkText(lead, 'claude', true).ok, true, `${lead.slice(0, 12)} with raw`);
  }
  // Jim 17:01Z: a split write can deliver a leading "?" alone, so any leading "?" is refused, for
  // every provider; one after a space (the composer is no longer empty) is text.
  for (const p of ['codex', 'antigravity', null]) assert.equal(T.checkText('?hello', p, false).ok, false, `leading ? for ${p}`);
  for (const literal of [' ?hello', '#note', '@file', 'what?']) assert.equal(T.checkText(literal, 'claude', false).ok, true, literal);
  assert.equal(T.checkText('l1\nl2', 'claude', false).ok, true, 'multi-line is measured for claude');
  for (const p of ['codex', 'antigravity', null]) assert.equal(T.checkText('l1\nl2', p, false).ok, false, `multi-line refused for ${p}`);
  assert.equal(T.checkText('x'.repeat(T.TERM_TEXT_MAX + 1), 'claude', false).ok, false);
  assert.equal(T.checkText('', 'claude', false).ok, false);
  assert.equal(T.checkText(42, 'claude', false).ok, false);
  assert.equal(T.checkText('\x1b[A', 'claude', false).ok, false, 'nothing left after the escapes');
});

test('term type: ONE write of the text, never framed (no 200~/201~), no Enter', async () => {
  for (const provider of ['claude', 'codex', 'antigravity']) {
    const r = rig({ provider });
    const out = await r.tc.handle('god', { action: 'type', agent: 'a1', text: 'fix the build' });
    assert.equal(out.status, 200, out.body.line);
    assert.deepEqual(r.writes.map((w) => w.data), ['fix the build'], provider);
  }
});

test('term send (MUST 2): Enter waits for the echo to settle AND the provider gap; Codex 400 chars >= its measured floor', async () => {
  const r = rig({ provider: 'codex' });
  const text = 'x'.repeat(400);
  const out = await r.tc.handle('god', { action: 'send', agent: 'a1', text });
  assert.equal(out.status, 200, out.body.line);
  assert.deepEqual(r.writes.map((w) => w.data), [text, '\r']);
  const gap = r.writes[1].at - r.writes[0].at;
  const codexGap = PA.automaticEnterGapMs('codex', 400);
  assert.ok(codexGap >= 800, `the codex formula's floor (${codexGap})`);
  assert.ok(gap >= codexGap, `Enter ${gap} ms after the text, provider gap ${codexGap}`);
  assert.match(out.body.line, new RegExp(`Enter after ${codexGap} ms`));
  // Claude: the settle (150 ms quiet) is the gap.
  const c = rig({ provider: 'claude' });
  await c.tc.handle('god', { action: 'send', agent: 'a1', text: 'hello' });
  const cg = c.writes[1].at - c.writes[0].at;
  assert.ok(cg >= T.TERM_SETTLE_QUIET_MS && cg < 800, `claude gap ${cg}`);
});

test('term send: an echo that keeps moving holds the Enter until it is quiet (capped)', async () => {
  const r = rig({ provider: 'claude' });
  const sleep = r.deps.sleep;
  r.deps.sleep = async (ms) => { await sleep(ms); if (r.t < 1_000 + 600) r.gen += 1; };   // output for 600 ms
  await r.tc.handle('god', { action: 'send', agent: 'a1', text: 'hello' });
  const gap = r.writes[1].at - r.writes[0].at;
  assert.ok(gap >= 600 + T.TERM_SETTLE_QUIET_MS - 25, `Enter after the output went quiet (${gap})`);
  const busy = rig({ provider: 'claude' });
  const s2 = busy.deps.sleep;
  busy.deps.sleep = async (ms) => { await s2(ms); busy.gen += 1; };   // never quiet
  await busy.tc.handle('god', { action: 'send', agent: 'a1', text: 'hello' });
  const g2 = busy.writes[1].at - busy.writes[0].at;
  assert.ok(g2 >= T.TERM_SETTLE_CAP_MS && g2 < T.TERM_SETTLE_CAP_MS + 100, `the cap holds (${g2})`);
});

test('term: one action at a time per target - a second send cannot land inside the first one\'s Enter gap', async () => {
  const r = rig({ provider: 'codex' });
  const p1 = r.tc.handle('god', { action: 'send', agent: 'a1', text: 'first' });
  const p2 = r.tc.handle('god', { action: 'send', agent: 'a1', text: 'second' });
  await Promise.all([p1, p2]);
  assert.deepEqual(r.writes.map((w) => w.data), ['first', '\r', 'second', '\r']);
});

test('term: a refused text writes nothing; a failed write is reported, logged and stops the action', async () => {
  const r = rig();
  for (const text of ['?', '!rm -rf', 'a\x03b']) assert.equal((await r.tc.handle('god', { action: 'send', agent: 'a1', text })).status, 400, text);
  assert.deepEqual(r.writes, []);
  r.writeFails = (d) => d === '\r';
  const out = await r.tc.handle('god', { action: 'send', agent: 'a1', text: 'hello' });
  assert.equal(out.status, 500);
  assert.match(out.body.line, /Enter write failed/);
  assert.equal(r.logs.at(-1).ok, false);
});

test('term log rows: every action one row, text clipped at 4K with its full length, screen tails bounded', async () => {
  const r = rig({ provider: 'claude' });
  r.screen.lines = Array.from({ length: 40 }, (_, i) => `row ${i} ${'y'.repeat(300)}`);
  const text = 'z'.repeat(T.TERM_LOG_TEXT_MAX + 500);
  await r.tc.handle('god', { action: 'type', agent: 'a1', text });
  const row = r.logs.at(-1);
  assert.equal(row.kind, 'term');
  assert.equal(row.by, 'god');
  assert.equal(row.agent, 'a1');
  assert.equal(row.action, 'type');
  assert.equal(row.ok, true);
  assert.equal(row.textLength, text.length);
  assert.equal(row.text.length, T.TERM_LOG_TEXT_MAX + 1, 'clipped, with an ellipsis');
  assert.equal(row.mode2004, true);
  for (const side of ['before', 'after']) {
    assert.equal(row[side].length, T.TERM_LOG_TAIL_ROWS, side);
    assert.ok(row[side].every((l) => l.length <= 241), `${side}: rows clipped at 240`);
  }
  assert.ok(JSON.stringify(row).length < 12_000, 'one row stays small');
  await r.tc.handle('god', { action: 'keys', agent: 'a1', keys: ['esc'] });
  assert.deepEqual(r.logs.at(-1).keys, ['esc']);
});

// ─── 4. origin GOD: interference sees god's typing (Jim MUST 1) ──────────────────────────

test('PtyManager.write: GOD advances the human generation AND lastHumanInputAt, like HUMAN; pty:write refuses GOD', () => {
  const pm = new PtyManager();
  pm.sessions.set('t1', { id: 't1', cwd: '', command: '', owner: null, lastOutputAt: 0, hasOutput: true, humanInputGeneration: 0, proc: { write: () => {} } });
  const before = Date.now();
  assert.deepEqual(pm.write('t1', 'x', 'GOD'), { ok: true });
  assert.equal(pm.humanInputGeneration('t1'), 1);
  assert.ok(pm.lastHumanInputAt('t1') >= before);
  const idx = src('src/main/index.ts');
  const handler = idx.slice(idx.indexOf("ipcMain.handle('pty:write'"));
  const body = handler.slice(0, handler.indexOf('\n});'));
  const refuse = body.indexOf("if (origin === 'GOD') return { ok: false, error: 'origin not permitted on this channel' };");
  assert.ok(refuse > 0 && refuse < body.indexOf('ptyManager.write('), 'the renderer can never declare GOD');
  assert.match(idx, /write: \(ptyId, data\) => ptyManager\.write\(ptyId, data, 'GOD'\)/, "term's writer binds GOD");
});

test('PtyManager.godEnterAt (god 8df2e3): only a GOD write carrying an Enter stamps it; the owner reads it through the wiring', () => {
  const pm = new PtyManager();
  pm.sessions.set('t1', { id: 't1', cwd: '', command: '', owner: null, lastOutputAt: 0, hasOutput: true, humanInputGeneration: 0, proc: { write: () => {} } });
  pm.write('t1', 'text', 'GOD');
  pm.write('t1', '\r', 'HUMAN');
  pm.write('t1', '\r', 'PROGRAMMATIC');
  assert.equal(pm.godEnterAt('t1'), undefined, "god's text, a person's Enter and the app's Enter are no god Enter");
  const before = Date.now();
  pm.write('t1', '\r', 'GOD');
  assert.ok(pm.godEnterAt('t1') >= before);
  assert.equal(pm.godEnterAt('nope'), undefined);
  assert.match(src('src/main/automaticSubmitWiring.ts'), /godEnterAt: \(ptyId\) => w\.pty\.godEnterAt\?\.\(ptyId\),/);
});

/** The owner over a REAL PtyManager session: the only human signal is what pty.ts records. */
function ownerWorld() {
  const pm = new PtyManager();
  const w = { vt: 1_792_000_000_000, timers: [], seq: 0, writes: [], prompt: '', pm, inc: { n: 1 } };
  pm.sessions.set('pty-alice', { id: 'pty-alice', cwd: '', command: '', owner: null, lastOutputAt: 0, hasOutput: true, humanInputGeneration: 0,
    proc: { write: (d) => { if (d === '\r') w.prompt = ''; else if (d !== '\x15') w.prompt += d; } } });
  /** God types through term: pty.ts stamps lastHumanInputAt with Date.now(), here the virtual clock. */
  w.god = (text) => { const real = Date.now; Date.now = () => w.vt; try { pm.write('pty-alice', text, 'GOD'); } finally { Date.now = real; } };
  w.at = (ms, fn) => { w.timers.push({ at: w.vt + ms, seq: (w.seq += 1), fn }); };
  w.deps = {
    resolvePty: () => 'pty-alice',
    incarnation: () => w.inc,
    humanGeneration: (id) => pm.humanInputGeneration(id),
    lastHumanInputAt: (id) => pm.lastHumanInputAt(id),
    write: (ptyId, data) => { w.writes.push(data); return pm.write(ptyId, data, 'PROGRAMMATIC'); },
    terminalReady: () => 'READY',
    eligibility: () => ({ eligible: true }),
    promptBlock: () => null,
    abortCapability: () => ({ kind: 'VERIFIED', clearControl: '\x15', settleMs: 300 }),
    readScreen: (_p, needle) => Promise.resolve({ onPromptRow: w.prompt.includes(needle), screenCount: w.prompt.includes(needle) ? 1 : 0 }),
    capacity: {
      admit: (agentId, workClass) => ({ verdict: 'ALLOW', reason: ADMISSION_REASON.AVAILABLE, poolKey: 'pool', state: null, workClass, limitEpochAt: null, grantId: null }),
      revalidate: () => ({ verdict: 'ALLOW', reason: ADMISSION_REASON.AVAILABLE }),
      confirmLaunch: () => {}, cancelGrant: () => {}, holdGrant: () => {}
    },
    now: () => w.vt,
    setTimer: (fn, ms) => { w.timers.push({ at: w.vt + ms, seq: (w.seq += 1), fn }); return w.seq; },
    onOutcome: () => {}
  };
  return w;
}
async function settle(w, promise) {
  let done = false; let value;
  promise.then((v) => { done = true; value = v; });
  for (let i = 0; i < 5000; i += 1) {
    await new Promise((r) => setImmediate(r));
    if (done) return value;
    if (!w.timers.length) throw new Error('stuck');
    w.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const next = w.timers.shift();
    w.vt = Math.max(w.vt, next.at);
    next.fn();
  }
  throw new Error('did not settle');
}
const wake = { requestId: 'r1', agentId: 'alice', admissionClass: 'CAPACITY_GATED', text: 'read your inbox now' };

test('MUST 1: god typing between STAGE and COMMIT makes the wake INTERFERED (no Enter on god\'s text)', async () => {
  const w = ownerWorld();
  w.at(50, () => w.god(' — god fixing it'));
  const o = new OWN.AutomaticSubmitOwner(w.deps);
  const out = await settle(w, o.submit(wake));
  assert.deepEqual(out, { kind: 'INTERFERED', reason: 'HUMAN_INPUT_AFTER_STAGE' });
  assert.ok(!w.writes.includes('\r'), 'no Enter after god typed');
  assert.ok(o.inhibition('pty-alice'), 'automatic delivery is held on that PTY');
});

test('MUST 1: god typing just before STAGE refuses the wake as HUMAN_INPUT_RECENT (nothing typed)', async () => {
  const w = ownerWorld();
  w.god('hello');
  w.vt += OWN.HUMAN_QUIET_MS - 200;
  const out = await settle(w, new OWN.AutomaticSubmitOwner(w.deps).submit(wake));
  assert.deepEqual(out, { kind: 'REFUSED', reason: 'HUMAN_INPUT_RECENT' });
  assert.deepEqual(w.writes, []);
  // Control: the same with a PROGRAMMATIC write is not a person.
  const c = ownerWorld();
  c.pm.write('pty-alice', 'x', 'PROGRAMMATIC');
  assert.equal((await settle(c, new OWN.AutomaticSubmitOwner(c.deps).submit(wake))).kind, 'COMMITTED');
});

// ─── 5. the broker route, the CLI, the env ───────────────────────────────────────────────

const { HookServer, TERM_HTTP_BODY_MAX } = loadTs('src/main/hooks.ts');

async function broker(t) {
  const sock = process.platform === 'win32' ? `\\\\.\\pipe\\gtc193-${process.pid}-${Math.random().toString(36).slice(2)}` : path.join(fs.mkdtempSync(path.join(JAIL, 's-')), 's.sock');
  const hive = {
    sockPath: () => sock, codexHomeFor: () => null, recordSession: () => {}, appendLog: () => {},
    registry: () => ({ godId: 'god', agents: { god: { id: 'god', provider: 'claude', isGod: true }, a1: { id: 'a1', provider: 'claude' } } }),
    isGod: (id) => id === 'god', rosterContext: () => '', recordModel: () => {}, appendCostLedger: () => {},
    toolOutputDir: (id) => path.join(JAIL, 'agents', id, 'tool-output')
  };
  const control = { shouldHalt: () => false, takeSteer: () => null, toolDecision: () => ({ deny: false }) };
  const s = new HookServer(hive, () => ({ send: () => {} }), () => ({}), control);
  s.start();
  t.after(() => s.stop());
  for (let i = 0; i < 200 && s.hookBrokerPort() === null; i++) await new Promise((r) => setTimeout(r, 5));
  return s;
}
function post(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
      let out = ''; res.on('data', (d) => { out += d; }); res.on('end', () => resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('broker: /term/<agent>/<token> reaches the handler with the token-proved id; a wrong token is 403; no handler is 404', async (t) => {
  assert.match(src('src/main/hooks.ts'), /HOOK_ROUTE = \/\^\\\/\(hook\|mcp\|status\|ledger\|term\)\\\//);
  const s = await broker(t);
  const url = s.hookUrl('god').replace('/hook/', '/term/');
  assert.equal((await post(url, { action: 'read', agent: 'a1' })).status, 404, 'no term handler wired: 404');
  const seen = [];
  s.setTermHandler((agentId, body) => { seen.push({ agentId, body }); return { status: 200, body: { ok: true, line: 'ok' } }; });
  assert.equal((await post(url, { action: 'read', agent: 'a1' })).status, 200);
  assert.deepEqual(seen, [{ agentId: 'god', body: { action: 'read', agent: 'a1' } }]);
  assert.equal((await post(url.replace(/[0-9a-f]{32}$/, '0'.repeat(32)), { action: 'read', agent: 'a1' })).status, 403);
  // a1's own token cannot claim god's id: the path agent and the token are bound together.
  const a1 = s.hookUrl('a1').replace('/hook/', '/term/');
  const forged = a1.replace('/term/a1/', '/term/god/');
  assert.equal((await post(forged, { action: 'read', agent: 'a1' })).status, 403);
  assert.ok(TERM_HTTP_BODY_MAX >= 64 * 1024);
});

const CLI = path.join(ROOT, 'resources', 'term-cli.cjs');
function run(args, { input, env, cli = CLI } = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [cli, ...args], { env: { ...process.env, HIVE_TERM_URL: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => resolve({ code, out, err }));
    c.stdin.end(input ?? '');
  });
}

test('CLI end to end against a real broker and TermControl: read, send (stdin, one trailing newline dropped), keys; non-god refused', async (t) => {
  const s = await broker(t);
  const r = rig({ provider: 'claude' });
  r.deps.sleep = async (ms) => { r.t += ms; };
  s.setTermHandler((agentId, body) => r.tc.handle(agentId, body));
  const env = { HIVE_TERM_URL: s.hookUrl('god').replace('/hook/', '/term/') };
  const read = await run(['read', 'a1'], { env });
  assert.equal(read.code, 0, read.err);
  assert.match(read.out, /^a1: cursor 2,1 {2}80x3 {2}paste2004=on\n\n❯ \n/);
  const send = await run(['send', 'a1'], { env, input: 'ran `touch x` and $(touch y)\n' });
  assert.equal(send.code, 0, send.err);
  assert.deepEqual(r.writes.map((w) => w.data), ['ran `touch x` and $(touch y)', '\r'], 'byte for byte, the trailing newline dropped');
  const keys = await run(['keys', 'a1', 'esc', 'enter'], { env });
  assert.equal(keys.code, 0, keys.err);
  const refused = await run(['send', 'a1'], { env, input: '?' });
  assert.equal(refused.code, 1);
  assert.match(refused.err, /^term: refused: a lone "\?"/);
  const forbidden = await run(['read', 'a1'], { env: { HIVE_TERM_URL: s.hookUrl('a1').replace('/hook/', '/term/') } });
  assert.equal(forbidden.code, 1);
  assert.match(forbidden.err, /god-only/);
});

// ─── GTC term rule: god rules on a held-interfered latch (only the UI could; Creed sat
// owner-inhibited 80 min, WAKE-FALSE-INTERFERED-RESTART) ──────────────────────────────────

function heldRig(TC = T.TermControl) {
  const r = rig();
  r.held = { a1: { requestId: 'inbox-wake:a1:x:0', reason: 'WAKE_TYPED_NOT_SENT', since: 1_000 - 19 * 60_000 } };
  r.rulings = [];
  r.deps.heldOf = (a) => r.held[a] ?? null;
  r.deps.resolveHeld = (a, how) => { r.rulings.push([a, how]); if (!r.held[a] || r.racing) return false; delete r.held[a]; return true; };
  r.tc = new TC(r.deps);
  return r;
}

function ruleChecks(TC = T.TermControl) {
  return (async () => {
    const r = heldRig(TC);
    const read = await r.tc.handle('god', { action: 'read', agent: 'a1' });
    assert.equal(read.status, 200);
    assert.equal(read.body.line, 'a1: cursor 2,1  80x3  paste2004=on\nHELD since 19 min (WAKE_TYPED_NOT_SENT, inbox-wake:a1:x:0): wakes are refused until a ruling - term rule a1 send-again|already-handled --id inbox-wake:a1:x:0', 'TERM READ SHOWS THE LATCH AND ITS ID');
    assert.equal(read.body.header, 'cursor 2,1  80x3  paste2004=on', 'the header itself is unchanged');
    const plain = await r.tc.handle('god', { action: 'read', agent: 'a2' });
    assert.equal(plain.body.line, 'a2: cursor 2,1  80x3  paste2004=on', 'nothing held: the line is as before');

    const bare = await r.tc.handle('god', { action: 'rule', agent: 'a1' });
    assert.equal(bare.status, 400, 'no default ruling');
    assert.match(bare.body.line, /there is no default/);
    assert.equal((await r.tc.handle('god', { action: 'rule', agent: 'a1', how: 'resolved', id: 'inbox-wake:a1:x:0' })).status, 400);
    assert.equal((await r.tc.handle('a2', { action: 'rule', agent: 'a1', how: 'SEND_AGAIN', id: 'inbox-wake:a1:x:0' })).status, 403, 'god-only');
    // GTC-ID: the ruling is bound to the hold god read. No id: refused before the hold is even looked at.
    const noId = await r.tc.handle('god', { action: 'rule', agent: 'a1', how: 'SEND_AGAIN' });
    assert.equal(noId.status, 400, 'NO --ID: REFUSED 400, THE RULING IS ON THE HOLD GOD READ');
    assert.match(noId.body.line, /--id <requestId> is required \(term read a1 prints it\)/);
    assert.equal((await r.tc.handle('god', { action: 'rule', agent: 'a1', how: 'SEND_AGAIN', id: '  ' })).status, 400, 'a blank id is no id');
    // A different hold than the one read (a newer wake replaced it): 409 names the hold that is there NOW.
    const stale = await r.tc.handle('god', { action: 'rule', agent: 'a1', how: 'SEND_AGAIN', id: 'inbox-wake:a1:old:0' });
    assert.equal(stale.status, 409, 'WRONG --ID: REFUSED 409, NEVER RULED ON THE HOLD GOD DID NOT READ');
    assert.equal(stale.body.line, 'refused: the hold on a1 is now inbox-wake:a1:x:0; read it again');
    assert.deepEqual(r.rulings, [], 'no refused request reached the ruling path');
    const staleRow = r.logs.filter((l) => l.action === 'rule').pop();
    assert.deepEqual([staleRow.id, staleRow.requestId, staleRow.ok], ['inbox-wake:a1:old:0', 'inbox-wake:a1:x:0', false], 'the row carries the id ruled on and the id held');

    r.racing = true;
    const raced = await r.tc.handle('god', { action: 'rule', agent: 'a1', how: 'SEND_AGAIN', id: 'inbox-wake:a1:x:0' });
    assert.equal(raced.status, 409, 'the ruling path said no: refused, never reported as done');
    assert.match(raced.body.line, /^refused: the hold on a1 is now inbox-wake:a1:x:0; read it again$/, 'the refusal names the hold that is there now');
    r.racing = false;

    const ok = await r.tc.handle('god', { action: 'rule', agent: 'a1', how: 'ALREADY_HANDLED', id: 'inbox-wake:a1:x:0' });
    assert.equal(ok.status, 200, 'THE RIGHT --ID RESOLVES');
    assert.equal(ok.body.line, 'a1: ruled ALREADY_HANDLED on inbox-wake:a1:x:0 (WAKE_TYPED_NOT_SENT, held 19 min): it is never typed again');
    assert.deepEqual(r.rulings, [['a1', 'SEND_AGAIN'], ['a1', 'ALREADY_HANDLED']]);
    const row = r.logs.filter((l) => l.action === 'rule' && l.ok).pop();
    assert.deepEqual(row, { kind: 'term', by: 'god', agent: 'a1', action: 'rule', how: 'ALREADY_HANDLED', id: 'inbox-wake:a1:x:0', requestId: 'inbox-wake:a1:x:0', reason: 'WAKE_TYPED_NOT_SENT', heldMs: 19 * 60_000, ok: true });

    const none = await r.tc.handle('god', { action: 'rule', agent: 'a1', how: 'SEND_AGAIN', id: 'inbox-wake:a1:x:0' });
    assert.equal(none.status, 409);
    assert.match(none.body.line, /a1 has nothing held/);
    assert.equal(r.rulings.length, 2, 'nothing held: the ruling path is not called');
    assert.deepEqual(r.writes, [], 'a ruling types nothing');

    r.held.a1 = { requestId: 'inbox-wake:a1:y:0', reason: 'INTERFERED', since: 1_000 };
    const old = await r.tc.handle('god', { action: 'rule', agent: 'a1', how: 'SEND_AGAIN', id: 'inbox-wake:a1:x:0' });
    assert.equal(old.body.line, 'refused: the hold on a1 is now inbox-wake:a1:y:0; read it again', 'the id god read earlier is not the hold now: read it again');
    const again = await r.tc.handle('god', { action: 'rule', agent: 'a1', how: 'SEND_AGAIN', id: 'inbox-wake:a1:y:0' });
    assert.match(again.body.line, /^a1: ruled SEND_AGAIN on inbox-wake:a1:y:0 .*delivered again through every guard$/);
  })();
}
test('term rule: god rules SEND_AGAIN or ALREADY_HANDLED through the ruling path, no default, --id required and bound to the hold read (409 names the hold now); term read shows the latch and its id', () => ruleChecks());

// GTC-ID mutants: each injects ONE defect into termControl.ts (loaded from text, the file untouched)
// and must turn ruleChecks RED on the named assert.
function mutateText(rel, edits, tag) {
  let text = src(rel);
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  return text;
}
const ID_MUTANTS = [
  { name: '--id not required: a bare ruling lands on whatever is held', dies: /NO --ID: REFUSED 400/,
    edits: [['    if (!id) return no(400, `rule: --id <requestId> is required', '    if (id === undefined) return no(400, `rule: --id <requestId> is required']] },
  { name: 'the id is not compared: a replaced hold is ruled on unseen', dies: /WRONG --ID: REFUSED 409/,
    edits: [['    if (h.requestId !== id) return no(409,', '    if (false && h.requestId !== id) return no(409,']] },
  { name: 'term read hides the id god must pass', dies: /TERM READ SHOWS THE LATCH AND ITS ID/,
    edits: [['send-again|already-handled --id ${h.requestId}`;', 'send-again|already-handled`;']] },
  { name: 'the right id is refused too (compare inverted: the wrong one passes, the right one is refused)', dies: /WRONG --ID: REFUSED 409|THE RIGHT --ID RESOLVES/,
    edits: [['    if (h.requestId !== id) return no(409,', '    if (h.requestId === id) return no(409,']] },
];
for (const m of ID_MUTANTS) {
  test(`GTC-ID mutant: ${m.name}`, async () => {
    const text = mutateText('src/main/termControl.ts', m.edits, m.name);
    const MT = loadTs.fromText('src/main/termControl.ts', text);
    await assert.rejects(ruleChecks(MT.TermControl), (e) => m.dies.test(String(e && e.message)) || (() => { throw new Error(`mutant "${m.name}" died elsewhere: ${e && e.message}`); })());
  });
}

test('term rule: an app without the ruling deps refuses it (503) and read is unchanged', async () => {
  const r = rig();
  const out = await r.tc.handle('god', { action: 'rule', agent: 'a1', how: 'SEND_AGAIN' });
  assert.equal(out.status, 503);
  assert.equal((await r.tc.handle('god', { action: 'read', agent: 'a1' })).body.line, 'a1: cursor 2,1  80x3  paste2004=on');
});

test('term rule wiring: index.ts gives TermControl the owner\'s inhibition and the ONE ruling function the IPC uses', () => {
  const idx = src('src/main/index.ts');
  assert.match(idx, /const h = p \? automaticSubmit\.inhibition\(p\) : null;\n\s+return h \? \{ requestId: h\.requestId, reason: h\.reason, since: h\.at \} : null;/);
  assert.match(idx, /resolveHeld: \(agentId, how\) => resolveHeldInterference\(agentId, how\),/);
  assert.match(idx, /ipcMain\.handle\('autoSubmit:resolveInterference'[\s\S]{0,400}return resolveHeldInterference\(agentId, how as InterferenceResolution\);\n\}\);/);
  const fn = idx.slice(idx.indexOf('function resolveHeldInterference('));
  assert.match(fn, /^function resolveHeldInterference\(agentId: string, how: InterferenceResolution\): boolean \{\n  const ptyId = ptyForAgent\(agentId\);\n  const resolved = ptyId \? automaticSubmit\.resolveInterference\(ptyId, how as InterferenceResolution\) : false;\n  pushAgentImpact\(\);\n[\s\S]{0,200}?  if \(resolved\) inboxWake\?\.onInterferenceResolved\(agentId, how as InterferenceResolution\);\n  return resolved;\n\}/);
  assert.equal(idx.split('automaticSubmit.resolveInterference(').length, 2, 'one caller of the owner\'s resolve');
  // The floor digest's held line tells god the term way, not only the Human's message box.
  // GTC-ID: the hint carries the id the ruling must name, and index.ts hands the digest that id.
  assert.match(src('src/main/floorDigest.ts'), /or rule it in \$\{who\}'s message box \(god: term read \$\{h\.agentId\}, then term rule \$\{h\.agentId\} send-again\|already-handled --id \$\{h\.requestId \?\? '<requestId from term read>'\}\)`/, 'THE DIGEST HINT NAMES THE ID');
  assert.match(idx, /heldWakes: \(\) => \(heldInterference\?\.noticed\(\) \?\? \[\]\)\.map\(\(h\) => \(\{ agentId: h\.agentId, name: agentDisplayName\(h\.agentId\), messages: h\.messages, since: h\.since, requestId: h\.requestId \}\)\),/, 'the digest gets the requestId');
});

test('GTC-ID mutant: the digest hint drops the id', () => {
  const text = mutateText('src/main/floorDigest.ts', [["send-again|already-handled --id ${h.requestId ?? '<requestId from term read>'})", 'send-again|already-handled)']], 'digest');
  assert.doesNotMatch(text, /then term rule \$\{h\.agentId\} send-again\|already-handled --id/);
});

async function cliRuleChecks(t, cli = CLI) {
  const go = (args, o) => run(args, { ...o, cli });
  assert.equal((await go(['rule', 'a1'])).code, 2, 'no default');
  assert.equal((await go(['rule', 'a1', 'resolved', '--id', 'inbox-wake:a1:x:0'])).code, 2);
  assert.equal((await go(['rule', 'a1', 'send-again', 'x'])).code, 2);
  assert.equal((await go(['rule', 'a1', 'constructor', '--id', 'inbox-wake:a1:x:0'])).code, 2, 'only the two names, never an inherited key');
  // GTC-ID: --id is required at the CLI too (usage, exit 2), before any request is made.
  const noId = await go(['rule', 'a1', 'send-again']);
  assert.equal(noId.code, 2, 'CLI: NO --ID IS A USAGE ERROR');
  assert.match(noId.err, /--id <requestId> is required/);
  assert.equal((await go(['rule', 'a1', 'send-again', '--id'])).code, 2, '--id with no value');
  assert.equal((await go(['rule', 'a1', 'send-again', '--id', '--raw'])).code, 2, 'a flag is not an id');
  assert.equal((await go(['rule', 'a1', 'send-again', '--id', 'inbox-wake:a1:x:0', 'x'])).code, 2, 'nothing after the id');
  assert.match((await go(['-h'])).out, /term rule <agent> send-again\|already-handled --id <requestId>/, 'usage names --id');
  const s = await broker(t);
  const r = heldRig();
  s.setTermHandler((agentId, body) => r.tc.handle(agentId, body));
  const env = { HIVE_TERM_URL: s.hookUrl('god').replace('/hook/', '/term/') };
  const wrong = await go(['rule', 'a1', 'already-handled', '--id', 'inbox-wake:a1:old:0'], { env });
  assert.equal(wrong.code, 1, 'CLI: THE WRONG ID IS REFUSED (409)');
  assert.match(wrong.err, /the hold on a1 is now inbox-wake:a1:x:0; read it again/);
  assert.deepEqual(r.rulings, [], 'the wrong id never reached the ruling path');
  const ok = await go(['rule', 'a1', 'send-again', '--id', 'inbox-wake:a1:x:0'], { env });
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /^a1: ruled SEND_AGAIN on inbox-wake:a1:x:0/);
  const none = await go(['rule', 'a1', 'already-handled', '--id', 'inbox-wake:a1:x:0'], { env });
  assert.equal(none.code, 1);
  assert.match(none.err, /a1 has nothing held/);
  assert.deepEqual(r.rulings, [['a1', 'SEND_AGAIN']]);
}
test('CLI: term rule <agent> send-again|already-handled --id <requestId>; a bare or unknown ruling or a missing --id is a usage error; the wrong id is refused', (t) => cliRuleChecks(t));

const CLI_ID_MUTANTS = [
  { name: 'CLI: --id optional (a bare ruling is sent)', dies: /CLI: NO --ID IS A USAGE ERROR/,
    edits: [["    if (!how) throw new Error('rule: send-again or already-handled (there is no default)');\n",
             "    if (!how) throw new Error('rule: send-again or already-handled (there is no default)');\n    if (rest.length === 1) return { body: { action, agent, how, id: 'inbox-wake:a1:x:0' } };\n"]] },
  { name: 'CLI: the id typed is not the id sent', dies: /CLI: THE WRONG ID IS REFUSED/,
    edits: [["    return { body: { action, agent, how, id: rest[2] } };", "    return { body: { action, agent, how, id: 'inbox-wake:a1:x:0' } };"]] },
];
for (const m of CLI_ID_MUTANTS) {
  test(`GTC-ID mutant: ${m.name}`, async (t) => {
    const text = mutateText('resources/term-cli.cjs', m.edits, m.name);
    const mutated = path.join(JAIL, `term-cli-mutant-${CLI_ID_MUTANTS.indexOf(m)}.cjs`);
    fs.writeFileSync(mutated, text);
    await assert.rejects(cliRuleChecks(t, mutated), (e) => m.dies.test(String(e && e.message)) || (() => { throw new Error(`mutant "${m.name}" died elsewhere: ${e && e.message}`); })());
  });
}

test('CLI argument rules: no text from arguments, bad flags, no URL', async () => {
  assert.equal((await run(['send', 'a1', 'hello there'])).code, 2, 'text in arguments is refused');
  assert.equal((await run(['type'])).code, 2);
  assert.equal((await run(['wipe', 'a1'])).code, 2);
  assert.equal((await run(['read', 'a1', '--rows', '0'])).code, 2);
  assert.equal((await run(['keys', 'a1'])).code, 2);
  assert.equal((await run(['send', 'a1'], { input: '' })).code, 2, 'no text');
  const none = await run(['read', 'a1']);
  assert.equal(none.code, 3);
  assert.match(none.err, /HIVE_TERM_URL is not set/);
  assert.equal((await run(['--help'])).code, 0);
});

test('CLI: --file reads the text from a file (a BOM dropped)', async (t) => {
  const s = await broker(t);
  const r = rig({ provider: 'claude' });
  s.setTermHandler((agentId, body) => r.tc.handle(agentId, body));
  const f = path.join(JAIL, 'msg.txt');
  fs.writeFileSync(f, '\uFEFFfrom a file');
  const out = await run(['type', 'a1', '--file', f], { env: { HIVE_TERM_URL: s.hookUrl('god').replace('/hook/', '/term/') } });
  assert.equal(out.code, 0, out.err);
  assert.deepEqual(r.writes.map((w) => w.data), ['from a file']);
});

test('env: HIVE_TERM_URL only in god\'s spawn env (Claude and Codex), never in Codex\'s config.toml; term on god\'s PATH only', async (t) => {
  const { HiveManager } = loadTs('src/main/hive.ts');
  const home = fs.mkdtempSync(path.join(JAIL, 'hive-'));
  // Codex reads its auth from the (redirected) home.
  fs.mkdirSync(path.join(os.homedir(), '.codex'), { recursive: true });
  fs.writeFileSync(path.join(os.homedir(), '.codex', 'auth.json'), '{"x":1}');
  const hive = new HiveManager(() => path.join(home, 'harness'));
  t.after(() => hive.dispose());
  let n = 0;
  hive.setHookBroker({
    urlFor: () => `http://127.0.0.1:43123/hook/${(n += 1).toString(16).padStart(32, '0')}`,
    mcpFor: () => { n += 1; const token = n.toString(16).padStart(32, '0'); return { url: `http://127.0.0.1:43123/mcp/${token}`, token }; },
    revoke: () => {}
  });
  const god = await hive.ensureAgent({ id: 'god', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  assert.match(god.env.HIVE_TERM_URL, /^http:\/\/127\.0\.0\.1:43123\/term\/[0-9a-f]{32}$/);
  assert.equal(god.env.HIVE_TERM_URL.replace('/term/', '/ledger/'), god.env.HIVE_LEDGER_URL, 'the same per-spawn token');
  const jim = await hive.ensureAgent({ id: 'jim-x', name: 'Jim', provider: 'claude', cwd: home });
  assert.equal(jim.env.HIVE_TERM_URL, undefined, 'a non-god agent has no term URL');
  assert.ok(jim.env.HIVE_LEDGER_URL);
  const cgod = await hive.ensureAgent({ id: 'godc', name: 'Michael', provider: 'codex', cwd: home, isGod: true });
  assert.ok(!cgod.refusal, cgod.refusal);
  assert.match(cgod.env.HIVE_TERM_URL, /\/term\//);
  const cfg = fs.readFileSync(path.join(cgod.env.CODEX_HOME, 'config.toml'), 'utf8');
  assert.doesNotMatch(cfg, /\/term\/|HIVE_TERM_URL/, 'the capability URL never lands in a file');
  const dwight = await hive.ensureAgent({ id: 'dwight-x', name: 'Dwight', provider: 'codex', cwd: home });
  assert.equal(dwight.env.HIVE_TERM_URL, undefined);
  // The command dir: bin/term holds only the term wrappers.
  const d = hive.writeTermCommand('C:\\app\\resources\\term-cli.cjs');
  assert.deepEqual(fs.readdirSync(d).sort(), process.platform === 'win32' ? ['term', 'term.cmd'] : ['term']);
  const idx = src('src/main/index.ts');
  assert.match(idx, /if \(opts\.hive\.isGod\) \{\n\s*const termDir = hive\.writeTermCommand\(TERM_CLI\);/);
  assert.match(src('electron-builder.yml'), /- from: resources\/term-cli\.cjs\s+to: term-cli\.cjs/);
  assert.match(src('src/main/devIsolation.ts'), /'HIVE_TERM_URL'/);
});

// ─── 6. the cost bar (Jim SHOULD 9) ──────────────────────────────────────────────────────

// MIRROR-STARTUP-196: the guard judges nothing in its startup window, so the rig starts past it.
// `parse` is the measured parse ms of the second (default: chars x msPerChar).
function costRig(msPerChar, eld = () => null, active = () => null) {
  const r = { t: 0, bytes: 0, parse: 0, off: [], logs: [] };
  r.g = new COST.MirrorCostGuard({ bytes: () => r.bytes, parseMs: () => r.parse, msPerChar, eldMs: eld, eluActiveMs: active, lastSpawnAt: () => 0,
    turnOff: (why) => r.off.push(why), turnOn: () => {}, enabled: () => true, log: (row) => r.logs.push(row), now: () => r.t });
  r.second = (chars, parse = chars * msPerChar) => { r.t += 1000; r.bytes += chars; r.parse += parse; return r.g.tick(); };
  while (r.t + 1000 < COST.MIRROR_STARTUP_GRACE_MS) r.second(0);
  return r;
}

test('cost bar: the measured live peak stays far under 2%; 2% sustained over the window turns the mirror off, once', () => {
  // The floor's peak minute: 6.84 MB in 60 s at the measured ~150 ms per 6.84 MB.
  const msPerChar = 150 / 6_840_000;
  const peak = costRig(msPerChar);
  for (let i = 0; i < 60; i++) assert.equal(peak.second(6_840_000 / 60), null);
  assert.deepEqual(peak.off, []);
  const hot = costRig(msPerChar);
  const hotChars = (0.03 * 1000) / msPerChar;   // 3% of a core
  for (let i = 0; i < COST.MIRROR_COST_WINDOW - 1; i++) assert.equal(hot.second(hotChars), null, 'not before the window is full');
  assert.equal(hot.second(hotChars), 'share');
  assert.deepEqual(hot.off, ['share']);
  assert.equal(hot.logs.at(-1).kind, 'mirror-auto-off');
  assert.equal(hot.second(hotChars), null, 'off stays off');
  assert.equal(hot.off.length, 1);
});

test('cost bar: event-loop delay turns it off only when the mirrors\' measured parse explains it, over the full window', () => {
  const msPerChar = 1e-5;
  const idle = costRig(msPerChar, () => 200, () => 900);
  for (let i = 0; i < 20; i++) idle.second(10);
  assert.deepEqual(idle.off, [], 'lag from another cause never turns the mirror off');
  const busy = costRig(msPerChar, () => 80, () => 15);
  const chars = (0.01 * 1000) / msPerChar;   // 1% of a core (10 ms/s): under the share bar, most of the 15 ms busy time
  for (let i = 0; i < COST.MIRROR_COST_WINDOW - 1; i++) assert.equal(busy.second(chars), null, 'never on one tick');
  assert.equal(busy.second(chars), 'event-loop-delay');
});

test('cost bar: the 6-agent resume burst (6 x 48k chars inside 3 s) is under the bar at the calibrated real parse cost', async () => {
  // Calibrate exactly as main does, then replay the POST-INSTALL-193 burst through six real mirrors.
  const sample = COST.calibrationSample();
  const cal = M.createTerminalMirror(120, 40);
  const t0 = performance.now();
  cal.write(sample);
  await cal.read(1);
  const msPerChar = (performance.now() - t0) / sample.length;
  cal.dispose();
  const mirrors = Array.from({ length: 6 }, () => M.createTerminalMirror(160, 40));
  const burst = COST.calibrationSample(48_000);
  const b0 = performance.now();
  for (const m of mirrors) m.write(burst);
  await Promise.all(mirrors.map((m) => m.read(1)));
  const burstMs = performance.now() - b0;
  for (const m of mirrors) m.dispose();
  const r = costRig(msPerChar);
  // MIRROR-STARTUP-196: the guard is charged the MEASURED parse (here the burst's wall time, an
  // upper bound), not chars x the cold calibration (under suite load that estimate alone passed 2%).
  for (let s = 0; s < 3; s++) r.second((6 * 48_000) / 3, burstMs / 3);
  for (let s = 0; s < 7; s++) r.second(500);
  assert.deepEqual(r.off, [], `the burst stays on (calibrated ${msPerChar.toExponential(2)} ms/char, burst parsed in ${burstMs.toFixed(0)} ms)`);
  assert.ok(burstMs < 3000 * 0.25, `six 48k resumes parse in ${burstMs.toFixed(0)} ms, well inside their 3 s`);
});

test('cost wiring: calibrated at ready, sampled per second, auto-off drops every mirror and stops new ones; config can turn it off', () => {
  const idx = src('src/main/index.ts');
  assert.match(idx, /if \(readConfig\(\)\.terminalMirror !== false\) ptyManager\.setMirrorFactory\(\(cols, rows\) => createTerminalMirror\(cols, rows\)\);/);
  assert.match(idx, /turnOff: \(\) => \{ ptyManager\.setMirrorFactory\(null\); ptyManager\.disposeMirrors\(\);/);
  assert.match(idx, /turnOn: \(\) => \{ ptyManager\.rearmMirrors\(\(cols, rows\) => createTerminalMirror\(cols, rows\)\);/);
  assert.match(idx, /void armMirrorCostGuard\(\);/);
  assert.match(idx, /logTermModes\(opts\.hive\.id, opts\.id, provider, didResume\)/);
});
