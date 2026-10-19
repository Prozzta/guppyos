'use strict';
/**
 * GOD-TERMINAL-CONTROL M2 (design doc section 13 + 13a): the screen gate can read main's mirror.
 *
 * - One reader, two hosts: shared/screenReading.ts holds both readings; the renderer's
 *   readScreenForNeedle / readCodexScreen and the mirror's needleReading / codexReading call it.
 * - config `screenGateSource` ('renderer' default | 'mirror'), read at every request; 'mirror'
 *   falls back to the renderer with a logged reason whenever the mirror has no reading.
 * - The shadow diff covers both readings in both directions, counted per reading kind x provider.
 * - Jim MUST 1: the mirror keeps the renderer's 10,000-line scrollback, and a mirror seeded by a
 *   re-arm is no source (it falls back, never answers header NONE).
 * - Jim MUST 2: a shadow read of the renderer (`shadow: true`) never aligns or redraws.
 *
 * HOME IS REDIRECTED AND ASSERTED before anything is built.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'gtc-m2-196-'));
const realEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME redirect failed - aborting before constructing anything');
test.after(() => {
  for (const [k, v] of Object.entries(realEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const SR = loadTs('src/shared/screenReading.ts');
const M = loadTs('src/main/terminalMirror.ts');
const SH = loadTs('src/main/termShadow.ts');
const G = loadTs('src/main/screenGate.ts');
const W = loadTs('src/main/automaticSubmitWiring.ts');
const { PtyManager } = loadTs('src/main/pty.ts');
const { Terminal } = require('@xterm/headless');
const { Unicode11Addon } = require('@xterm/addon-unicode11');

const FX = path.join(__dirname, 'fixtures', 'tui-composer-allowlist');
const WSG = path.join(__dirname, 'fixtures', 'wake-screen-guard');
const fixture = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

/** The rows as a buffer, the shape both hosts hand the shared reader (the viewport is the last `rows`). */
function plainBuf(lines, cursorRow, rows = lines.length) {
  const baseY = Math.max(0, lines.length - rows);
  return { baseY, cursorY: cursorRow - baseY, length: lines.length, getLine: (i) => (i >= 0 && i < lines.length ? { translateToString: () => lines[i] } : undefined) };
}

/** Draws `lines` into a fresh mirror as a TUI would (colour, absolute moves), cursor at the end of `cursorRow`. */
function drawn(lines, cursorRow, cols, make) {
  const m = M.createTerminalMirror(cols, lines.length, make);
  let bytes = '\x1b[H\x1b[2J';
  lines.forEach((l, i) => { bytes += `\x1b[${i + 1};1H\x1b[38;5;${100 + (i % 50)}m${l}\x1b[0m`; });
  bytes += `\x1b[${cursorRow + 1};${Math.min(cols, lines[cursorRow].length + 1)}H`;
  m.write(bytes);
  return m;
}

/** Writes `lines` as a stream (each scrolls the last off the top), then puts the cursor on `cursorRow`. */
function streamed(lines, cursorRow, cols, rows, make) {
  const m = M.createTerminalMirror(cols, rows, make);
  m.write(lines.join('\r\n'));
  const top = lines.length - rows;
  m.write(`\x1b[${cursorRow - top + 1};${Math.min(cols, lines[cursorRow].length + 1)}H`);
  return m;
}

/** A headless terminal as createHeadless makes it, but with `scrollback` lines (the 1,000 of M1). */
const headlessWith = (scrollback) => (c, r) => {
  const t = new Terminal({ cols: c, rows: r, scrollback, allowProposedApi: true });
  t.loadAddon(new Unicode11Addon());
  t.unicode.activeVersion = '11';
  return t;
};

const CASES = [
  ...['claude-hive-statusline-idle', 'claude-hive-statusline-boot'].map((n) => ({ name: n, fx: fixture(FX, n) })),
  ...['2-trusted-idle-80x24', '1-untrusted-trust-80x24'].map((n) => ({ name: `codex ${n}`, fx: fixture(WSG, n) }))
];

// ─── 1. one reader, two hosts ──────────────────────────────────────────────────────────────

test('one reader: the renderer functions are the pool lookup plus the shared call; the mirror calls the same', () => {
  const pool = src('src/renderer/src/components/terminalPool.ts');
  const body = (name) => { const at = pool.indexOf(`export function ${name}(`); return pool.slice(at, pool.indexOf('\n}\n', at)); };
  const needle = body('readScreenForNeedle');
  assert.match(needle, /if \(!entry \|\| entry\.exited \|\| !entry\.opened \|\| !needle\) return null;\s*try \{\s*return needleReading\(entry\.term\.buffer\.active, entry\.term\.rows, needle, expectedTail\);/);
  assert.ok(needle.split('\n').length <= 9, 'a thin wrapper, no reader of its own');
  const codex = body('readCodexScreen');
  assert.match(codex, /if \(!entry \|\| entry\.exited \|\| !entry\.opened\) return null;\s*try \{\s*return codexReading\(entry\.term\.buffer\.active, expectedTail\);/);
  assert.ok(codex.split('\n').length <= 9, 'a thin wrapper, no reader of its own');
  const mirror = src('src/main/terminalMirror.ts');
  assert.match(mirror, /async needleReading\(needle, expectedTail\) \{\s*await drained\(\);\s*return disposed \? null : timed\(\(\) => needleReading\(t\.buffer\.active, t\.rows, needle, expectedTail\)\);/);
  assert.match(mirror, /async codexReading\(expectedTail\) \{\s*await drained\(\);\s*return disposed \? null : timed\(\(\) => codexReading\(t\.buffer\.active, expectedTail\)\);/);
  // The moved helpers: the renderer paths re-export the shared ones, so nothing can fork.
  assert.match(src('src/renderer/src/components/composerAttestation.ts'), /^\/\/[^\n]*\nexport \* from '@shared\/composerAttestation';\n$/);
  assert.match(src('src/renderer/src/components/terminalScrollback.ts'), /^\/\/[^\n]*\nexport \{ TERMINAL_SCROLLBACK_LINES \} from '@shared\/terminalScrollback';\n$/);
  assert.ok(!/@xterm\//.test(src('src/shared/composerAttestation.ts').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')), 'the shared helper imports no xterm type');
});

test('MUST 1 (a): the mirror keeps the renderer\'s scrollback, from the one constant; both load Unicode 11', () => {
  const { TERMINAL_SCROLLBACK_LINES } = loadTs('src/shared/terminalScrollback.ts');
  assert.equal(TERMINAL_SCROLLBACK_LINES, 10_000);
  assert.equal(M.MIRROR_SCROLLBACK, TERMINAL_SCROLLBACK_LINES);
  assert.equal(loadTs('src/renderer/src/components/terminalScrollback.ts').TERMINAL_SCROLLBACK_LINES, TERMINAL_SCROLLBACK_LINES);
  const mirror = src('src/main/terminalMirror.ts');
  assert.match(mirror, /export const MIRROR_SCROLLBACK = TERMINAL_SCROLLBACK_LINES;/);
  assert.match(mirror, /new Term\(\{ cols, rows, scrollback: MIRROR_SCROLLBACK, allowProposedApi: true \}\);\s*t\.loadAddon\(new Unicode11Addon\(\)\);\s*t\.unicode\.activeVersion = '11';/);
  const pool = src('src/renderer/src/components/terminalPool.ts');
  assert.match(pool, /scrollback: TERMINAL_SCROLLBACK_LINES,/);
  assert.match(pool, /term\.loadAddon\(new Unicode11Addon\(\)\);\s*term\.unicode\.activeVersion = '11';/);
  const t = M.createHeadless(80, 24);
  assert.equal(t.options.scrollback, 10_000, 'the real headless terminal is made with it');
  assert.equal(t.unicode.activeVersion, '11');
  t.dispose();
});

for (const c of CASES) {
  test(`same answers: the mirror reads ${c.name} as the shared reader reads the rows (both readings)`, async () => {
    const { lines, cursorRow, cols } = c.fx;
    const tail = lines[cursorRow].trim().slice(-12) || undefined;
    const needle = lines[cursorRow].trim() || lines.find((l) => l.trim()).trim();
    const m = drawn(lines, cursorRow, cols);
    try {
      const wantCodex = SR.codexReading(plainBuf(lines, cursorRow), tail);
      assert.deepEqual(await m.codexReading(tail), wantCodex);
      const wantNeedle = SR.needleReading(plainBuf(lines, cursorRow), lines.length, needle, tail);
      assert.ok(wantNeedle.screenCount >= 1, 'the needle is on the screen');
      assert.deepEqual(await m.needleReading(needle, tail), wantNeedle);
      assert.deepEqual(await m.needleReading('not on this screen at all', tail), { ...wantNeedle, onPromptRow: false, screenCount: 0 });
    } finally { m.dispose(); }
  });
}

test('same answers: the CODEX-WAKE-162 skeleton (a TUI-dropped em dash) matches on both hosts', async () => {
  const typed = 'Status: done — the card is closed and the branch is pushed';
  const shown = typed.replace(' — ', '  ');
  const lines = ['● ok', '', `› ${shown}`, '', '  ? for shortcuts'];
  const m = drawn(lines, 2, 100);
  try {
    const want = SR.needleReading(plainBuf(lines, 2), lines.length, typed, typed);
    assert.equal(want.onPromptRow, true, 'the tolerant matcher sees it');
    assert.deepEqual(await m.needleReading(typed, typed), want);
  } finally { m.dispose(); }
});

test('the shared reader: no needle, no prompt row or a throwing buffer is no reading', () => {
  const b = plainBuf(['a', 'b'], 1);
  assert.equal(SR.needleReading(b, 2, ''), null);
  assert.equal(SR.needleReading({ ...b, cursorY: 9 }, 2, 'a'), null);
  const bad = { ...b, getLine: () => { throw new Error('x'); } };
  assert.equal(SR.needleReading(bad, 2, 'a'), null);
  assert.equal(SR.codexReading(bad), null);
  assert.equal('promptTailMatches' in SR.needleReading(b, 2, 'b', 'x'.repeat(SR.MAX_ATTESTED_TAIL + 1)), false, 'an over-long tail is not checked');
});

// ─── 2. MUST 1 (b): a header past 1,000 lines, and a re-armed mirror ─────────────────────────

function longCodexSession(filler = 1_500) {
  const fx = fixture(WSG, '2-trusted-idle-80x24');
  // The NEWEST header box (the capture has two); the transcript goes under it.
  const boxEnd = fx.lines.findLastIndex((l, i) => i < fx.cursorRow && l.startsWith('╰'));
  assert.ok(boxEnd > 0, 'the fixture has its header box');
  assert.ok(!fx.lines.slice(boxEnd + 1).some((l) => l.includes('>_ OpenAI Codex')), 'and no header below it');
  // The footer's `<model> <effort> · <cwd>` status line (M3) is evidence of the model on its own
  // (WSG-NO-MARKER-177); without it only the header box says MODEL, which is what this measures.
  const footer = fx.lines.slice(boxEnd + 1).filter((l, i) => !(boxEnd + 1 + i > fx.cursorRow && l.includes('capstub-none default · ')));
  assert.equal(footer.length, fx.lines.length - boxEnd - 2, 'the status line was there to drop');
  const lines = [...fx.lines.slice(0, boxEnd + 1), ...Array.from({ length: filler }, (_, i) => `• transcript line ${i}`), ...footer];
  return { lines, cursorRow: fx.cursorRow + filler, cols: fx.cols };
}

test('MUST 1: a Codex header pushed past 1,000 lines is still read by the mirror (MODEL, never NONE)', async () => {
  const s = longCodexSession();
  const want = SR.codexReading(plainBuf(s.lines, s.cursorRow, 24));
  assert.equal(want.codex.header, 'MODEL', 'the renderer, with 10,000 lines, reads the header');
  const m = streamed(s.lines, s.cursorRow, s.cols, 24);
  try {
    const got = await m.codexReading();
    assert.equal(got.codex.header, 'MODEL');
    assert.deepEqual(got, want);
  } finally { m.dispose(); }
  // Teeth: M1's 1,000-line mirror reads the same stream as NONE: the bug this pins.
  const short = streamed(s.lines, s.cursorRow, s.cols, 24, headlessWith(1000));
  try { assert.equal((await short.codexReading()).codex.header, 'NONE'); } finally { short.dispose(); }
});

/** A PtyManager session as the spawn makes it (no node-pty). */
function session(id, mirror, tail = '') {
  return { id, cwd: '', command: '', owner: null, lastOutputAt: 0, hasOutput: false, humanInputGeneration: 0, tail,
    mirror, proc: { write: () => {}, cols: 80, rows: 24 }, spawnedAt: 0 };
}

test('MUST 1: a mirror made by a re-arm is no source (seeded); one fed from the spawn answers; no PTY / no mirror say so', async () => {
  const pm = new PtyManager();
  const fresh = drawn(['hello', '› x'], 1, 40);
  pm.sessions.set('fresh', session('fresh', fresh));
  pm.sessions.set('live', session('live', undefined, '\x1b[H\x1b[2J› seeded tail'));
  pm.rearmMirrors((c, r) => M.createTerminalMirror(c, r));
  assert.ok(pm.sessions.get('live').mirror, 'the re-arm gave the live session a mirror');
  assert.deepEqual(await pm.mirrorGateReading('live', 'codex', '', undefined), { reading: null, reason: 'seeded' });
  assert.deepEqual(await pm.mirrorGateReading('live', 'needle', 'seeded', undefined), { reading: null, reason: 'seeded' });
  assert.equal(pm.sessions.get('fresh').mirrorSeeded, undefined, 'a mirror from the spawn is not touched by the re-arm');
  const ok = await pm.mirrorGateReading('fresh', 'needle', 'x', undefined);
  assert.equal(ok.reading.onPromptRow, true);
  assert.equal(ok.reason, undefined);
  assert.equal((await pm.mirrorGateReading('fresh', 'codex', '', undefined)).reading.codex.cursorRow, '› x');
  assert.deepEqual(await pm.mirrorGateReading('nope', 'codex', '', undefined), { reading: null, reason: 'no-pty' });
  pm.sessions.set('bare', session('bare', undefined));
  assert.deepEqual(await pm.mirrorGateReading('bare', 'codex', '', undefined), { reading: null, reason: 'no-mirror' });
  pm.disposeMirrors();
});

/** A mirror whose reading resolves only when the test says (the drain held open). */
function heldMirror(reading = { onPromptRow: true, screenCount: 1 }, ms = 4.2) {
  let open;
  const gate = new Promise((r) => { open = r; });
  const read = async () => { await gate; return reading; };
  return { mirror: { codexReading: read, needleReading: read, lastReadMs: () => ms, dispose() {} }, open };
}

test('SHOULD 1: a session that ends, or a mirror replaced, while the drain awaits answers null with "replaced", never the old reading', async () => {
  const swaps = {
    'session replaced': (pm, id) => pm.sessions.set(id, session(id, heldMirror().mirror)),
    'session ended': (pm, id) => pm.sessions.delete(id),
    'mirror replaced': (pm, id) => { pm.sessions.get(id).mirror = heldMirror().mirror; },
    'mirror dropped': (pm, id) => { pm.sessions.get(id).mirror = undefined; }
  };
  for (const [name, swap] of Object.entries(swaps)) {
    for (const kind of ['codex', 'needle']) {
      const pm = new PtyManager();
      const h = heldMirror();
      pm.sessions.set('p', session('p', h.mirror));
      const got = pm.mirrorGateReading('p', kind, 'x', undefined);
      await flush();
      swap(pm, 'p');
      h.open();
      assert.deepEqual(await got, { reading: null, reason: 'replaced' }, `${name} (${kind})`);
    }
  }
  // The control: no swap, the same reading, with the mirror's read time (SHOULD 2).
  const pm = new PtyManager();
  const h = heldMirror();
  pm.sessions.set('p', session('p', h.mirror));
  const got = pm.mirrorGateReading('p', 'codex', '', undefined);
  h.open();
  assert.deepEqual(await got, { reading: { onPromptRow: true, screenCount: 1 }, ms: 4.2 });
  // Through the gate: a race falls back to the renderer, logged as 'replaced', not as the mirrors' state.
  const r = gateRig({ src: 'mirror', mirrorAns: { reading: null, reason: 'replaced' }, why: 'auto-off' });
  assert.equal(await r.gate.codex('p1'), R_READ);
  assert.equal(r.rows[0].fallback, 'replaced');
});

test('SHOULD 2: the real mirror times its sync read; the gate sums the read time per kind into the summary', async () => {
  const m = drawn(Array.from({ length: 300 }, (_, i) => `line ${i}`).concat(['› x']), 300, 40);
  try {
    assert.equal(m.lastReadMs(), 0, 'nothing read yet');
    await m.codexReading();
    const a = m.lastReadMs();
    assert.ok(Number.isFinite(a) && a > 0, `a codex read is timed (${a})`);
    await m.needleReading('x');
    assert.ok(Number.isFinite(m.lastReadMs()) && m.lastReadMs() > 0, 'a needle read is timed');
  } finally { m.dispose(); }
  // The mirror source: each answered or null reading carries ms; a reading without ms is not counted.
  const r = gateRig({ src: 'mirror', mirrorAns: { reading: M_READ, ms: 2 } });
  await r.gate.codex('p1');
  r.mirrorAns = { reading: M_READ, ms: 6 };
  await r.gate.codex('p1');
  r.mirrorAns = { reading: null, reason: 'unreadable', ms: 1 };
  await r.gate.needle('p1', 'x');
  r.mirrorAns = { reading: M_READ };
  await r.gate.needle('p1', 'x');
  r.t = G.SCREEN_SOURCE_SUMMARY_MS;
  await r.gate.needle('p1', 'x');
  assert.deepEqual(r.rows.at(-1), { kind: 'screen-source-summary', mirror: 4, 'fallback:unreadable': 1,
    mirrorReadMs: { codex: { n: 2, ms: 8, max: 6 }, needle: { n: 1, ms: 1, max: 1 } } });
  // The window resets: the next summary carries only its own reads.
  r.mirrorAns = { reading: M_READ, ms: 3 };
  await r.gate.codex('p1');
  r.t = 2 * G.SCREEN_SOURCE_SUMMARY_MS;
  await r.gate.codex('p1');
  assert.deepEqual(r.rows.at(-1).mirrorReadMs, { codex: { n: 2, ms: 6, max: 3 } });
  // The renderer source (the default): the shadow's mirror read is counted too.
  const d = gateRig({ src: 'renderer', mirrorAns: { reading: M_READ, ms: 5.25 } });
  await d.gate.codex('p1');
  await flush();
  d.t = G.SCREEN_SOURCE_SUMMARY_MS;
  await d.gate.codex('p1');
  assert.deepEqual(d.rows.at(-1), { kind: 'screen-source-summary', renderer: 2, mirrorReadMs: { codex: { n: 1, ms: 5.3, max: 5.3 } } });
});

test('MUST 1: with source mirror, a re-armed mirror and a 1,000-line... fall back to the renderer with the reason', async () => {
  const pm = new PtyManager();
  pm.sessions.set('live', session('live', undefined, '› tail'));
  pm.rearmMirrors((c, r) => M.createTerminalMirror(c, r));
  const R = { onPromptRow: false, screenCount: 0, codex: { header: 'MODEL', startingAfterHeader: false, cursorRow: '›', footer: [] } };
  const r = gateRig({ src: 'mirror', renderer: R, mirror: (ptyId, kind, needle, tail) => pm.mirrorGateReading(ptyId, kind, needle, tail) });
  assert.equal(await r.gate.codex('live'), R, 'the renderer answers, never the seeded mirror');
  assert.deepEqual(r.calls.filter((c) => c.host === 'renderer').map((c) => c.shadow), [false], 'asked as the gate, not as a shadow');
  assert.deepEqual(r.rows.find((x) => x.kind === 'screen-source'), { kind: 'screen-source', ptyId: 'live', agentId: 'a1', requested: 'mirror', answeredBy: 'renderer', fallback: 'seeded' });
  pm.disposeMirrors();
});

// ─── 3. the source switch ─────────────────────────────────────────────────────────────────

const R_READ = { onPromptRow: true, screenCount: 1, promptTailMatches: true };
const M_READ = { onPromptRow: true, screenCount: 1, promptTailMatches: true };

/** The gate over fake hosts; `G2` = a mutated screenGate module. */
function gateRig(o = {}, G2 = G) {
  const r = { src: o.src ?? 'renderer', gen: 7, t: 0, calls: [], rows: [], samples: [], why: o.why ?? 'auto-off',
    rendererAns: 'renderer' in o ? o.renderer : R_READ, mirrorAns: o.mirrorAns ?? { reading: M_READ } };
  r.gate = G2.createScreenGate({
    source: () => G2.screenGateSourceOf(r.src),
    renderer: (ptyId, needle, tail, codex, shadow) => { r.calls.push({ host: 'renderer', ptyId, needle, tail, codex, shadow }); return Promise.resolve(r.rendererAns); },
    mirror: o.mirror ?? ((ptyId, kind, needle, tail) => { r.calls.push({ host: 'mirror', ptyId, kind, needle, tail }); return typeof r.mirrorAns === 'function' ? r.mirrorAns() : Promise.resolve(r.mirrorAns); }),
    whyNoMirror: () => r.why,
    generation: () => r.gen,
    who: () => ({ agentId: 'a1', provider: 'codex' }),
    record: o.record ?? ((s) => r.samples.push(s)),
    log: (row) => r.rows.push(row),
    now: () => r.t
  });
  return r;
}

test('source renderer (the default): the gate gets the renderer\'s reading untouched; the mirror is read after, for the shadow only', async () => {
  for (const unset of [undefined, 'renderer', 'bogus']) assert.equal(G.screenGateSourceOf(unset), 'renderer');
  const r = gateRig({ src: undefined });
  const got = await r.gate.needle('p1', 'hello', 'lo');
  assert.equal(got, R_READ, 'the same object the renderer answered');
  await flush();
  assert.deepEqual(r.calls, [
    { host: 'renderer', ptyId: 'p1', needle: 'hello', tail: 'lo', codex: false, shadow: false },
    { host: 'mirror', ptyId: 'p1', kind: 'needle', needle: 'hello', tail: 'lo' }
  ]);
  assert.deepEqual(r.samples, [{ agentId: 'a1', provider: 'codex', ptyId: 'p1', kind: 'needle', answeredBy: 'renderer', renderer: R_READ, mirror: M_READ, still: true }]);
  await r.gate.codex('p1', 't');
  await flush();
  assert.deepEqual(r.calls.slice(2), [
    { host: 'renderer', ptyId: 'p1', needle: '', tail: 't', codex: true, shadow: false },
    { host: 'mirror', ptyId: 'p1', kind: 'codex', needle: '', tail: 't' }
  ]);
});

test('source mirror: the mirror answers the gate; the renderer is read after with shadow:true and compared', async () => {
  const r = gateRig({ src: 'mirror' });
  assert.equal(await r.gate.codex('p1', 't'), M_READ);
  await flush();
  assert.deepEqual(r.calls, [
    { host: 'mirror', ptyId: 'p1', kind: 'codex', needle: '', tail: 't' },
    { host: 'renderer', ptyId: 'p1', needle: '', tail: 't', codex: true, shadow: true }
  ]);
  assert.equal(r.samples.length, 1);
  assert.equal(r.samples[0].answeredBy, 'mirror');
  assert.equal(r.samples[0].renderer, R_READ);
  assert.equal(r.samples[0].mirror, M_READ);
});

test('the source is read at every request: a config write switches the next reading, no restart', async () => {
  const r = gateRig();
  await r.gate.needle('p1', 'x');
  r.src = 'mirror';
  await r.gate.needle('p1', 'x');
  r.src = 'renderer';
  await r.gate.needle('p1', 'x');
  await flush();
  assert.deepEqual(r.samples.map((s) => s.answeredBy), ['renderer', 'mirror', 'renderer']);
  assert.deepEqual(r.rows.filter((x) => x.kind === 'screen-source').map((x) => `${x.requested}:${x.answeredBy}`), ['renderer:renderer', 'mirror:mirror', 'renderer:renderer'], 'a row on every change');
});

test('fallback: every mirror null is answered by the renderer as the gate, with the reason logged', async () => {
  const cases = [
    [{ reading: null, reason: 'no-mirror' }, 'auto-off', 'auto-off'],
    [{ reading: null, reason: 'no-mirror' }, 'failed', 'failed'],
    [{ reading: null, reason: 'no-mirror' }, 'config-off', 'config-off'],
    [{ reading: null, reason: 'seeded' }, 'auto-off', 'seeded'],
    [{ reading: null, reason: 'no-pty' }, 'auto-off', 'no-pty'],
    [{ reading: null, reason: 'unreadable' }, 'auto-off', 'unreadable'],
    [{ reading: null, reason: 'replaced' }, 'config-off', 'replaced'],
    [() => Promise.reject(new Error('boom')), 'auto-off', 'unreadable']
  ];
  for (const [mirrorAns, why, want] of cases) {
    const r = gateRig({ src: 'mirror', mirrorAns, why });
    assert.equal(await r.gate.needle('p1', 'x'), R_READ, `${want}: the renderer's reading`);
    await flush();
    assert.deepEqual(r.calls.filter((c) => c.host === 'renderer').map((c) => c.shadow), [false], `${want}: asked once, as the gate`);
    assert.equal(r.rows[0].fallback, want);
    assert.equal(r.samples.length, 0, `${want}: nothing to compare`);
  }
  // The renderer's own null still holds the item, as today.
  const held = gateRig({ src: 'mirror', mirrorAns: { reading: null, reason: 'seeded' }, renderer: null });
  assert.equal(await held.gate.codex('p1'), null);
});

test('rows: screen-source once per PTY until it changes, a 10-minute summary, forgotten with the PTY', async () => {
  const r = gateRig({ src: 'mirror' });
  await r.gate.needle('p1', 'x'); await r.gate.needle('p1', 'x'); await r.gate.needle('p2', 'x');
  r.mirrorAns = { reading: null, reason: 'no-mirror' };
  await r.gate.needle('p1', 'x');
  assert.deepEqual(r.rows.map((x) => `${x.ptyId}:${x.answeredBy}:${x.fallback ?? ''}`), ['p1:mirror:', 'p2:mirror:', 'p1:renderer:auto-off']);
  r.gate.forget('p2');
  r.mirrorAns = { reading: M_READ };
  await r.gate.needle('p2', 'x');
  assert.equal(r.rows.length, 4, 'a forgotten PTY logs its source again');
  r.t = G.SCREEN_SOURCE_SUMMARY_MS;
  await r.gate.needle('p1', 'x');
  assert.deepEqual(r.rows.at(-1), { kind: 'screen-source-summary', mirror: 5, 'fallback:auto-off': 1 });
});

test('the shadow never touches the gate: output in between is moving, a throwing recorder or host is swallowed', async () => {
  const r = gateRig({ mirrorAns: () => { r.gen += 1; return Promise.resolve({ reading: M_READ }); } });
  await r.gate.needle('p1', 'x');
  await flush();
  assert.equal(r.samples[0].still, false, 'output arrived before the second read');
  const t = gateRig({ record: () => { throw new Error('disk'); } });
  assert.equal(await t.gate.needle('p1', 'x'), R_READ);
  const u = gateRig({ mirrorAns: () => Promise.reject(new Error('gone')) });
  assert.equal(await u.gate.needle('p1', 'x'), R_READ);
  const v = gateRig({ src: 'mirror' });
  v.rendererAns = undefined;
  assert.equal(await v.gate.needle('p1', 'x'), M_READ);
  await flush();
});

test('a never-opened tab: renderer null, mirror answered is its own count, never an agreement or a difference', async () => {
  const rows = [];
  let t = 0;
  const d = new SH.ShadowDiff((x) => rows.push(x), () => t);
  const r = gateRig({ renderer: null, record: (s) => d.record(s) });
  assert.equal(await r.gate.codex('p1'), null, 'source renderer: the renderer\'s null still holds');
  await flush();
  t = SH.SHADOW_SUMMARY_MS;
  d.record({ agentId: 'a1', ptyId: 'p1', provider: 'claude', kind: 'needle', answeredBy: 'renderer', renderer: R_READ, mirror: null, still: true });
  const sum = rows.at(-1);
  assert.equal(sum.kind, 'term-shadow-summary');
  assert.deepEqual(sum.by['codex/codex'], { agree: 0, disagree: 0, moving: 0, rendererNull: 1, mirrorNull: 0, bothNull: 0 });
  assert.deepEqual(sum.by['needle/claude'], { agree: 0, disagree: 0, moving: 0, rendererNull: 0, mirrorNull: 1, bothNull: 0 });
  assert.equal(sum.disagree, 0);
});

// ─── 4. the shadow diff on both readings ───────────────────────────────────────────────────

const facts = (o = {}) => ({ header: 'MODEL', startingAfterHeader: false, cursorRow: '› ', footer: ['? for shortcuts'], tail: ['› '], ...o });

test('ShadowDiff: the erase oracle\'s fields, the Codex facts, the tail match and the gate class are all compared', () => {
  const rows = [];
  const d = new SH.ShadowDiff((x) => rows.push(x), () => 0);
  const s = (kind, renderer, mirror, provider = 'codex') => ({ agentId: 'a1', ptyId: `p${rows.length}`, provider, kind, answeredBy: 'mirror', renderer, mirror, still: true });
  const n = { onPromptRow: true, screenCount: 2, promptTailMatches: true };
  assert.equal(d.record(s('needle', n, { ...n })), 'agree');
  for (const k of ['onPromptRow', 'screenCount', 'promptTailMatches']) {
    const other = { ...n, [k]: k === 'screenCount' ? 1 : false };
    assert.equal(d.record(s('needle', n, other)), 'disagree', k);
    assert.deepEqual(rows.at(-1).fields, [k]);
    assert.deepEqual(rows.at(-1).renderer, { [k]: n[k] });
    assert.equal(rows.at(-1).reading, 'needle');
    assert.equal(rows.at(-1).answeredBy, 'mirror');
  }
  const c = { onPromptRow: false, screenCount: 0, codex: facts() };
  assert.equal(d.record(s('codex', c, { ...c, codex: facts() })), 'agree');
  assert.equal(d.record(s('codex', c, { ...c, codex: facts({ header: 'NONE' }) })), 'disagree');
  assert.ok(rows.at(-1).fields.includes('header'));
  assert.equal(rows.at(-1).renderer.header, 'MODEL');
  assert.deepEqual(rows.at(-1).mirror.tail, ['› '], 'the tail rides along, to judge it by');
  assert.equal(d.record(s('codex', { ...c, promptTailMatches: true }, { ...c, promptTailMatches: false })), 'disagree');
  assert.deepEqual(rows.at(-1).fields, ['promptTailMatches']);
  assert.equal(d.record(s('codex', c, { onPromptRow: false, screenCount: 0 })), 'disagree');
  assert.deepEqual(rows.at(-1).fields, ['codex']);
  const fx = fixture(WSG, '2-trusted-idle-80x24');
  const ready = { onPromptRow: false, screenCount: 0, codex: SR.codexReading(plainBuf(fx.lines, fx.cursorRow)).codex };
  assert.equal(SH.gateClass('codex', ready.codex), 'READY');
  assert.deepEqual(SH.readingDiff('codex', 'codex', ready, { ...ready, codex: { ...ready.codex, cursorRow: '› typed' } }), ['cursorRow', 'class'], 'a different class is a field of its own');
});

test('ShadowDiff: counts per reading kind x provider (the flip bar), totals for the old readers', () => {
  const rows = [];
  let t = 0;
  const d = new SH.ShadowDiff((x) => rows.push(x), () => t);
  const n = { onPromptRow: true, screenCount: 1 };
  const s = (kind, provider, mirror, still = true) => ({ agentId: 'a', ptyId: 'p', provider, kind, answeredBy: 'renderer', renderer: n, mirror, still });
  d.record(s('needle', 'claude', n));
  d.record(s('needle', 'claude', n, false));
  d.record(s('needle', 'codex', n));
  d.record(s('codex', 'codex', null));
  d.record({ ...s('codex', null, null), renderer: null });
  t = SH.SHADOW_SUMMARY_MS;
  d.record(s('codex', 'codex', n));
  const z = { agree: 0, disagree: 0, moving: 0, rendererNull: 0, mirrorNull: 0, bothNull: 0 };
  assert.deepEqual(rows.at(-1), {
    kind: 'term-shadow-summary', agree: 3, disagree: 0, moving: 1, rendererNull: 0, mirrorNull: 1, bothNull: 1,
    by: { 'codex/codex': { ...z, agree: 1, mirrorNull: 1 }, 'codex/unknown': { ...z, bothNull: 1 }, 'needle/claude': { ...z, agree: 1, moving: 1 }, 'needle/codex': { ...z, agree: 1 } }
  });
});

// ─── 5. MUST 2: the shadow read of the renderer has no side effects ────────────────────────

test('MUST 2: the broker sends shadow:true only for a shadow read; plain and Codex requests are unchanged', () => {
  const sent = [];
  const b = new W.ScreenReadingBroker((...a) => { sent.push(a); return true; }, 10_000, () => ({}));
  void b.request('p1', 'n', 't');
  void b.request('p1', '', 't', true);
  void b.request('p1', '', 't', true, true);
  void b.request('p1', 'n', 't', false, true);
  assert.deepEqual(sent.map((a) => a.slice(2)), [['n', 't'], ['', 't', true], ['', 't', true, true], ['n', 't', false, true]]);
});

function responderPins(pool, index, preload) {
  assert.match(pool, /if \(req\.codex === true && req\.shadow !== true && entry\.opened && !entry\.exited\) \{\s*const host = entry\.host;/, 'the align-and-redraw block is skipped for a shadow read');
  assert.match(index, /\.\.\.\(codex \? \{ codex: true, grid: ptyManager\.grid\(ptyId\) \} : \{\}\), \.\.\.\(shadow \? \{ shadow: true \} : \{\}\)/, 'main puts the flag on the request');
  assert.match(index, /renderer: \(ptyId, needle, expectedTail, codex, shadow\) => screenReadings\.request\(ptyId, needle, expectedTail, codex, shadow\),/, 'the gate hands the flag to the broker');
  assert.match(preload, /onScreenReadRequest: \(cb: \(req: \{ requestId: string; ptyId: string; needle: string; expectedTail\?: string; shadow\?: boolean;/);
}

test('MUST 2: the renderer never aligns or redraws for a shadow read; main sets the flag; the gate asks with it (above)', () => {
  responderPins(src('src/renderer/src/components/terminalPool.ts'), src('src/main/index.ts'), src('src/preload/index.ts'));
});

test('wiring: both readings go through the gate, the mirror reading comes from PtyManager, the reasons from the guard', () => {
  const idx = src('src/main/index.ts');
  assert.match(idx, /source: \(\) => screenGateSourceOf\(readConfig\(\)\.screenGateSource\),/, 'read per request');
  assert.match(idx, /mirror: \(ptyId, kind, needle, expectedTail\) => ptyManager\.mirrorGateReading\(ptyId, kind, needle, expectedTail\),/);
  assert.match(idx, /whyNoMirror: \(\) => \(readConfig\(\)\.terminalMirror === false \? 'config-off' : mirrorGuard\?\.status\(\) \? 'auto-off' : 'failed'\),/);
  assert.match(idx, /termShadow\.forget\(id\);\n\s*screenGate\.forget\(id\);/);
  assert.ok(!/function shadowed\(/.test(idx), 'the M1 one-way tap is gone');
  const pty = src('src/main/pty.ts');
  assert.match(pty, /s\.mirror = f\(s\.proc\.cols, s\.proc\.rows\);\n\s*s\.mirrorSeeded = true;/, 'the re-arm marks its mirrors seeded');
  assert.match(src('src/main/config.ts'), /screenGateSource\?: 'renderer' \| 'mirror';/);
});

// ─── 6. mutants: each change below must be caught by the checks above ─────────────────────

const mutate = (rel, from, to) => {
  const text = src(rel);   // LF, whatever the checkout
  assert.ok(text.includes(from), `${rel}: the mutant's anchor exists: ${from}`);
  return text.replace(from, to);
};
const fails = async (fn) => { try { await fn(); } catch { return true; } return false; };

test('mutants: the source, the fallback, both shadow directions, a diff field, still, the seeded mark and the scrollback are each caught', async () => {
  const gate = (from, to) => loadTs.fromText('src/main/screenGate.ts', mutate('src/main/screenGate.ts', from, to));
  const shadow = (from, to) => loadTs.fromText('src/main/termShadow.ts', mutate('src/main/termShadow.ts', from, to));
  const killed = {
    'source ignored': await fails(async () => {
      const r = gateRig({ src: 'mirror' }, gate("if (requested === 'mirror') {", 'if (false) {'));
      assert.equal(await r.gate.codex('p1'), M_READ);
    }),
    'fallback dropped': await fails(async () => {
      const r = gateRig({ src: 'mirror', mirrorAns: { reading: null, reason: 'seeded' } }, gate("fallbackReason(m.reason, d.whyNoMirror));\n      return d.renderer(ptyId, needle, expectedTail, codex, false);", 'fallbackReason(m.reason, d.whyNoMirror));\n      return null;'));
      assert.equal(await r.gate.needle('p1', 'x'), R_READ);
    }),
    'renderer-source shadow dropped': await fails(async () => {
      const r = gateRig({}, gate("shadow('renderer', r, m.reading);", 'void m;'));
      await r.gate.needle('p1', 'x'); await flush();
      assert.equal(r.samples.length, 1);
    }),
    'mirror-source shadow dropped': await fails(async () => {
      const r = gateRig({ src: 'mirror' }, gate(".then((r) => shadow('mirror', r, mine), () => undefined)", '.then(() => undefined, () => undefined)'));
      await r.gate.needle('p1', 'x'); await flush();
      assert.equal(r.samples.length, 1);
    }),
    'shadow flag dropped by the gate': await fails(async () => {
      const r = gateRig({ src: 'mirror' }, gate('codex, true).then', 'codex, false).then'));
      await r.gate.codex('p1'); await flush();
      assert.equal(r.calls.find((c) => c.host === 'renderer').shadow, true);
    }),
    'needle field dropped from the diff': await fails(() => {
      const S2 = shadow("['onPromptRow', 'screenCount', 'promptTailMatches']", "['onPromptRow', 'promptTailMatches']");
      assert.deepEqual(S2.readingDiff('needle', 'claude', { onPromptRow: true, screenCount: 2 }, { onPromptRow: true, screenCount: 1 }), ['screenCount']);
    }),
    'still ignored': await fails(() => {
      const S2 = shadow("else if (!s.still) verdict = 'moving';", '');
      const d = new S2.ShadowDiff(() => {}, () => 0);
      assert.equal(d.record({ agentId: 'a', ptyId: 'p', provider: 'claude', kind: 'needle', answeredBy: 'renderer', renderer: R_READ, mirror: { ...R_READ, screenCount: 3 }, still: false }), 'moving');
    }),
    'seeded check removed': await fails(async () => {
      const P2 = loadTs.fromText('src/main/pty.ts', mutate('src/main/pty.ts', "    if (s.mirrorSeeded) return { reading: null, reason: 'seeded' };\n", ''));
      const pm = new P2.PtyManager();
      pm.sessions.set('live', session('live', undefined, '› tail'));
      pm.rearmMirrors((c, r) => M.createTerminalMirror(c, r));
      try { assert.equal((await pm.mirrorGateReading('live', 'codex', '', undefined)).reason, 'seeded'); } finally { pm.disposeMirrors(); }
    }),
    'scrollback back to 1,000': await fails(async () => {
      const M2 = loadTs.fromText('src/main/terminalMirror.ts', mutate('src/main/terminalMirror.ts', 'export const MIRROR_SCROLLBACK = TERMINAL_SCROLLBACK_LINES;', 'export const MIRROR_SCROLLBACK = 1000;'));
      const s = longCodexSession();
      const m = M2.createTerminalMirror(s.cols, 24);
      m.write(s.lines.join('\r\n'));
      try { assert.equal((await m.codexReading()).codex.header, 'MODEL'); } finally { m.dispose(); }
    }),
    'renderer aligns on a shadow read': await fails(() => responderPins(
      mutate('src/renderer/src/components/terminalPool.ts', 'req.shadow !== true && ', '').replace(/\r\n/g, '\n'), src('src/main/index.ts'), src('src/preload/index.ts'))),
    'main drops the flag': await fails(() => responderPins(
      src('src/renderer/src/components/terminalPool.ts'), mutate('src/main/index.ts', ', ...(shadow ? { shadow: true } : {})', '').replace(/\r\n/g, '\n'), src('src/preload/index.ts'))),
    'broker drops the flag': await fails(() => {
      const W2 = loadTs.fromText('src/main/automaticSubmitWiring.ts', mutate('src/main/automaticSubmitWiring.ts', 'sent = shadow ?', 'sent = false ?'));
      const sent = [];
      void new W2.ScreenReadingBroker((...a) => { sent.push(a); return true; }, 10_000, () => ({})).request('p1', '', 't', true, true);
      assert.deepEqual(sent[0].slice(2), ['', 't', true, true]);
    })
  };
  assert.deepEqual(Object.entries(killed).filter(([, k]) => !k).map(([n]) => n), [], 'every mutant is killed');
});
