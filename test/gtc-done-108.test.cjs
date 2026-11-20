'use strict';
require('./tools/own-job.cjs');
/**
 * GOD-TERMINAL-CONTROL 108, the done pin (god d37a95). God's `term` drives a real PTY end to end:
 * the real PtyManager (with the mirror factory main sets) and the real TermControl, wired as
 * src/main/index.ts wires them (readScreen and outputGeneration from the PtyManager, writes with
 * origin GOD). The child is a fake TUI in the shape of each provider (claude, codex, agy). It
 * records every byte it reads, and it runs a "turn" that streams until ESC or Ctrl+C stops it.
 *
 * For each provider, idle and mid-turn (the TUI is streaming, so a screen gate would say not
 * ready):
 *   - `read` returns the live screen;
 *   - `type` text arrives byte-exact (non-ASCII too) and `send` adds the Enter;
 *   - `keys` enter / esc / ctrl-c arrive as \r, \x1b, \x03, and esc / ctrl-c stop the turn;
 *   - the child is still alive after every action, and every term row is by god with ok:true.
 * TermControl is not the screen gate: nothing on this path asks whether the screen is ready.
 * Mutants: test/tools/gtc-done-108-mutants.cjs.
 *
 * HOME IS REDIRECTED AND ASSERTED before anything is built.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { tempDir, removeDir } = require('./tools/test-temp.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'gtc-done-108-'));
const realEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME redirect failed - aborting before constructing anything');
test.after(() => {
  for (const [k, v] of Object.entries(realEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const ROOT = path.join(__dirname, '..');
const M = loadTs('src/main/terminalMirror.ts');
const T = loadTs('src/main/termControl.ts');
const { PtyManager } = loadTs('src/main/pty.ts');

const PROMPTS = { claude: '❯ ', codex: '› ', agy: '> ' };
const BUSY = 'working (esc to interrupt)';

/** The fake TUI: argv = byte log, shape. Raw stdin; every chunk read is logged as hex, in order. */
const TUI = String.raw`'use strict';
const fs = require('fs');
const LOG = process.argv[2]; const SHAPE = process.argv[3];
const P = ${JSON.stringify(PROMPTS)}[SHAPE];
let composer = ''; let turn = null; let n = 0;
const out = (s) => process.stdout.write(s);
const prompt = () => out('\r\n' + P + composer);
function stop(why) { if (turn) { clearInterval(turn); turn = null; out('\r\n[interrupted by ' + why + ']'); } else out('\r\n[' + why + ' at idle]'); prompt(); }
function start() {
  if (turn) return;
  n = 0;
  turn = setInterval(() => { n += 1; out('\r\nline ' + n + ' ${BUSY}'); if (n >= 2000) { clearInterval(turn); turn = null; out('\r\n[turn end]'); prompt(); } }, 30);
}
process.stdin.setRawMode(true);
process.stdin.on('data', (d) => {
  fs.appendFileSync(LOG, d.toString('hex') + '\n');
  for (const ch of d.toString('utf8')) {
    if (ch === '\x1b') stop('esc');
    else if (ch === '\x03') stop('ctrl-c');
    else if (ch === '\r') { const t = composer; composer = ''; out('\r\n[submit] ' + t); start(); }
    else { composer += ch; if (!turn) out(ch); }
  }
});
out('TUI ' + SHAPE + ' up'); prompt();
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Polls `fn` until it is truthy; the bound only ends a broken run, it never decides a pass. */
async function until(what, fn, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) assert.fail(`never: ${what}`);
    await sleep(25);
  }
}

async function rig(provider) {
  const dir = tempDir(`gtc-done-${provider}-`);
  fs.writeFileSync(path.join(dir, 'tui.cjs'), TUI);
  const byteLog = path.join(dir, 'bytes.log');
  fs.writeFileSync(byteLog, '');
  const pm = new PtyManager();
  // As main does when config terminalMirror is not false (index.ts).
  pm.setMirrorFactory((cols, rows) => M.createTerminalMirror(cols, rows));
  const ptyId = `gtc-done-${provider}`;
  const agent = `gtc-${provider}`;
  const sink = { isDestroyed: () => false, send: () => {} };
  const r = await pm.spawn({ id: ptyId, cwd: dir, command: process.execPath, args: [path.join(dir, 'tui.cjs'), byteLog, provider], cols: 100, rows: 30, env: {} }, sink);
  assert.ok(r.ok, `spawn: ${r.error}`);
  const rows = [];
  // The deps as src/main/index.ts builds them for the god-only term channel.
  const tc = new T.TermControl({
    godId: () => 'god',
    ptyOf: (a) => (a === agent ? ptyId : undefined),
    providerOf: () => provider,
    readScreen: (id, n) => pm.readScreen(id, n),
    write: (id, data) => pm.write(id, data, 'GOD'),
    outputGeneration: (id) => pm.outputGeneration(id),
    log: (row) => rows.push(row),
    now: () => Date.now(),
    sleep
  });
  const screen = async () => ((await pm.readScreen(ptyId)) || { lines: [] }).lines.join('\n');
  const bytes = () => Buffer.concat(fs.readFileSync(byteLog, 'utf8').split('\n').filter(Boolean).map((h) => Buffer.from(h, 'hex'))).toString('utf8');
  const alive = () => pm.sessions.has(ptyId) && (() => { try { process.kill(pm.sessions.get(ptyId).proc.pid, 0); return true; } catch { return false; } })();
  const term = async (body) => {
    const reply = await tc.handle('god', { agent, ...body });
    const row = rows[rows.length - 1];
    assert.equal(reply.status, 200, `${body.action} ${JSON.stringify(body.keys ?? body.text ?? '')}: ${reply.body.line}`);
    assert.equal(reply.body.ok, true);
    assert.equal(row.kind, 'term'); assert.equal(row.by, 'god'); assert.equal(row.ok, true);
    return { reply, row };
  };
  const done = async () => { await pm.killAllAsync(5_000); await removeDir(dir); };
  return { pm, tc, ptyId, agent, rows, screen, bytes, alive, term, done };
}

/** Waits until the TUI streams (output moving and the busy line on screen): a turn is running. */
async function busy(x) {
  await until('the turn streams', async () => (await x.screen()).includes(BUSY));
  const g = x.pm.outputGeneration(x.ptyId);
  await until('output moves', () => x.pm.outputGeneration(x.ptyId) !== g);
}

for (const provider of ['claude', 'codex', 'agy']) {
  test(`${provider}: god reads, types and sends keys on a real PTY, idle and mid-turn`, { skip: process.platform !== 'win32' }, async () => {
    const x = await rig(provider);
    try {
      // The banner and the prompt are two writes; ConPTY can deliver them apart, so wait for the prompt row too.
      await until('the TUI is up at its prompt', async () => { const s = await x.screen(); return s.includes(`TUI ${provider} up`) && s.split('\n').some((l) => l.startsWith(PROMPTS[provider].trimEnd())); });
      let want = '';
      const arrived = async (what) => {
        await until(`${JSON.stringify(what)} arrives`, () => x.bytes().length >= want.length);
        assert.equal(x.bytes(), want, `the child read exactly the bytes god sent (after ${JSON.stringify(what)})`);
        assert.ok(x.alive(), `the child is alive after ${JSON.stringify(what)}`);
      };

      // ─── idle ───
      const read = await x.term({ action: 'read' });
      assert.ok(read.reply.body.screen.some((l) => l.startsWith(PROMPTS[provider].trimEnd())), `read shows the ${provider} prompt`);
      assert.equal((await x.term({ action: 'read', rows: 10 })).reply.body.screen.length, 10, '--rows 10 = the last 10 rows');

      const text = 'GTC idle café 中文 1+1';
      await x.term({ action: 'type', text });
      want += text; await arrived('type');
      await until('the typed text is on screen', async () => (await x.screen()).includes(text));
      await x.term({ action: 'keys', keys: ['ctrl-u'] });
      want += '\x15'; await arrived('ctrl-u');
      await x.term({ action: 'keys', keys: ['esc'] });
      want += '\x1b'; await arrived('esc idle');
      await until('esc reached the TUI at idle', async () => (await x.screen()).includes('[esc at idle]'));
      await x.term({ action: 'keys', keys: ['ctrl-c'] });
      want += '\x03'; await arrived('ctrl-c idle');
      await until('ctrl-c reached the TUI at idle', async () => (await x.screen()).includes('[ctrl-c at idle]'));

      // `send` = the text, then Enter: the turn starts.
      await x.term({ action: 'send', text: 'PONG-I' });
      want += 'PONG-I\r'; await arrived('send idle');
      await busy(x);

      // ─── mid-turn: the TUI is streaming; a screen gate would say not ready ───
      const g0 = x.pm.outputGeneration(x.ptyId);
      const mid = await x.term({ action: 'read' });
      assert.ok(mid.reply.body.screen.join('\n').includes(BUSY), 'read mid-turn shows the streaming turn');

      const midText = 'GTC mid été';
      const typed = await x.term({ action: 'type', text: midText });
      assert.ok(typed.row.before.join('\n').includes(BUSY), 'the type landed while the turn streamed');
      want += midText; await arrived('type mid-turn');

      const esc = await x.term({ action: 'keys', keys: ['esc'] });
      assert.ok(esc.row.before.join('\n').includes(BUSY), 'esc landed while the turn streamed');
      want += '\x1b'; await arrived('esc mid-turn');
      await until('esc interrupted the turn', async () => (await x.screen()).includes('[interrupted by esc]'));

      // Enter alone submits the queued text: a new turn.
      await x.term({ action: 'keys', keys: ['enter'] });
      want += '\r'; await arrived('enter');
      await busy(x);
      const send = await x.term({ action: 'send', text: 'PONG-M' });
      assert.ok(send.row.before.join('\n').includes(BUSY), 'the send landed while the turn streamed');
      want += 'PONG-M\r'; await arrived('send mid-turn');

      const cc = await x.term({ action: 'keys', keys: ['ctrl-c'] });
      assert.ok(cc.row.before.join('\n').includes(BUSY), 'ctrl-c landed while the turn streamed');
      want += '\x03'; await arrived('ctrl-c mid-turn');
      await until('ctrl-c interrupted the turn', async () => (await x.screen()).includes('[interrupted by ctrl-c]'));

      assert.notEqual(x.pm.outputGeneration(x.ptyId), g0);
      assert.ok(x.rows.length >= 13 && x.rows.every((r) => r.kind === 'term' && r.by === 'god' && r.ok === true), 'every term row: by god, ok');
      assert.ok(x.alive(), 'the child is alive at the end');
    } finally {
      await x.done();
    }
  });
}

test('only god drives a terminal: another caller is refused and nothing is written', { skip: process.platform !== 'win32' }, async () => {
  const x = await rig('claude');
  try {
    await until('the TUI is up', async () => (await x.screen()).includes('TUI claude up'));
    const reply = await x.tc.handle('jim-mtujpe28', { action: 'type', agent: x.agent, text: 'not god' });
    assert.equal(reply.status, 403);
    assert.equal(reply.body.ok, false);
    await sleep(300);
    assert.equal(x.bytes(), '', 'nothing reached the child');
  } finally {
    await x.done();
  }
});

test('source: the term path never consults a screen gate or readiness, and index.ts wires it as this test does', () => {
  const tc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'termControl.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.doesNotMatch(tc, /screenGate|createScreenGate|shadowClass|isReady|notReady/);
  const idx = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.ts'), 'utf8');
  assert.match(idx, /readScreen: \(ptyId, rows\) => ptyManager\.readScreen\(ptyId, rows\)/);
  assert.match(idx, /ptyManager\.write\(ptyId, data, 'GOD'\)/);
  assert.match(idx, /outputGeneration: \(ptyId\) => ptyManager\.outputGeneration\(ptyId\)/);
});
