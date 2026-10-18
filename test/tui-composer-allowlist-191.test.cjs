'use strict';

/**
 * TUI-COMPOSER-ALLOWLIST-191: Guppy's automatic typing never acts on a non-composer screen for
 * Claude Code or Antigravity (Creed's NUDGE-INTO-TUI G1-G6, repro plans R1-R5 steps a and b).
 *
 * (a) captured screens fed to the guard (shared/tuiComposer.ts);
 * (b) the REAL AutomaticSubmitOwner through the REAL buildOwnerDeps, the screen served from the
 *     same fixtures: on every dialog PASS = refused and ZERO bytes written; on every real idle
 *     composer (plain, a draft, after compact, Remote Control) the nudge is delivered.
 * R4 (Codex) is the control: its allowlist and its fixtures are unchanged.
 *
 * Fixtures: test/fixtures/tui-composer-allowlist/*.json. Each says in `source` whether it is a
 * REAL xterm replay of captured PTY bytes or DERIVED from claude.exe 2.1.302 strings (screens
 * that cannot be reached offline without a keystroke). agy-settings-error is the dialog of the
 * 2026-10-17 capture slip (god: use it as a negative fixture).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const TUI = loadTs('src/shared/tuiComposer.ts');
const SHARED = loadTs('src/shared/codexScreen.ts');
const PA = loadTs('src/shared/providerAutomation.ts');
const { AutomaticSubmitOwner } = loadTs('src/main/automaticSubmit.ts');
const { buildOwnerDeps, SCREEN_GUARDED_PROVIDERS } = loadTs('src/main/automaticSubmitWiring.ts');
const { CapacityRuntime } = loadTs('src/main/capacityRuntime.ts');
const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');

const FX = path.join(__dirname, 'fixtures', 'tui-composer-allowlist');
const WSG = path.join(__dirname, 'fixtures', 'wake-screen-guard');
const fixture = (name, dir = FX) => {
  const fx = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
  assert.ok(Array.isArray(fx.lines) && Number.isInteger(fx.cursorRow), `${name}: lines + cursorRow`);
  return fx;
};
const facts = (fx) => SHARED.extractCodexScreen((i) => fx.lines[i], fx.lines.length, fx.cursorRow);
const GLYPH = { claude: '❯', antigravity: '>' };
const RULE = /^─{20,}$/;

const TEXT = '[hive] check inbox';
const T0 = 1_800_000_000_000;

/** Every dialog fixture, with the provider it is shown to. G1-G5. */
const DIALOGS = [
  ['antigravity', 'agy-settings-error', /Settings Error/],          // the capture slip's dialog (agy trust path)
  ['antigravity', 'agy-theme-picker', /dialog/],
  ['claude', 'claude-trust', /Accessing workspace/],
  ['claude', 'claude-bypass', /Bypass Permissions mode/],
  ['claude', 'claude-apikey', /dialog/],
  ['claude', 'claude-login-picker', /Select login method/],
  ['claude', 'claude-paste-code', /Paste code here/],
  ['claude', 'claude-paste-code-typed', /Paste code here/],
  ['claude', 'claude-rate-limit', /What do you want to do\?/],
  ['claude', 'claude-rc-dialog', /dialog/],
  ['claude', 'claude-offline-onboarding', /no-composer/]
];
/** Every real idle composer the floor shows. */
const IDLE = [
  ['claude', 'claude-idle-120x40', 'empty-composer'],
  ['claude', 'claude-idle-80x24', 'empty-composer'],
  ['claude', 'claude-compact', 'empty-composer'],
  ['claude', 'claude-rc', 'empty-composer'],
  ['claude', 'claude-rc-notice', 'empty-composer'],
  ['claude', 'claude-noauth-idle', 'empty-composer'],
  ['claude', 'claude-hive-statusline-boot', 'empty-composer'],
  ['claude', 'claude-hive-statusline-idle', 'empty-composer'],
  ['claude', 'claude270-boot', 'placeholder'],
  ['claude', 'claude270-afterclear', 'placeholder'],
  ['antigravity', 'agy127-boot', 'empty-composer'],
  ['antigravity', 'agy127-afterclear', 'empty-composer']
];

// ─── (a) the guard on captured screens ───────────────────────────────────────────────────

test('(a) every fixture is labelled REAL or DERIVED', () => {
  for (const f of fs.readdirSync(FX)) {
    const fx = JSON.parse(fs.readFileSync(path.join(FX, f), 'utf8'));
    assert.match(fx.source, /^(REAL|DERIVED)\b/, `${f}: source says how it was made`);
  }
});

test('(a) G1-G5: every captured dialog is refused (MODAL or UNKNOWN), and it names what it saw', () => {
  for (const [prov, name, why] of DIALOGS) {
    const out = TUI.classifyTuiComposer(prov, facts(fixture(name)));
    assert.ok(out.cls === 'MODAL' || out.cls === 'UNKNOWN', `${name}: refused (got ${JSON.stringify(out)})`);
    assert.match(out.reason, why, `${name}: the reason names the dialog`);
    // Not past startup either: a dialog never latches condition 1.
    assert.equal(TUI.tuiPastStartup(out).open, false, `${name}: no latch`);
    // And with our own text expected (COMMIT), still not ours.
    const own = TUI.classifyTuiComposer(prov, facts(fixture(name)), TEXT).cls;
    assert.ok(own !== 'READY_OWN_DRAFT' && own !== 'READY', `${name}: never our draft (${own})`);
  }
});

test('(a) G5: text typed into the "Paste code here" field is never our draft', () => {
  const f = facts(fixture('claude-paste-code-typed'));
  assert.equal(TUI.classifyTuiComposer('claude', f, TEXT).cls, 'MODAL');
  assert.equal(TUI.classifyTuiComposer('claude', f, 'check inbox').cls, 'MODAL');
});

test('(a) positives: every REAL idle composer (plain, compact, Remote Control, 2.1.270 placeholder, agy) is READY', () => {
  for (const [prov, name, reason] of IDLE) {
    const out = TUI.classifyTuiComposer(prov, facts(fixture(name)));
    assert.deepEqual(out, { cls: 'READY', reason }, name);
    assert.equal(TUI.tuiPastStartup(out).open, true, `${name}: latches`);
  }
});

test('(a) a draft: a person\'s text is DRAFT; our own staged marker is READY_OWN_DRAFT (REAL captures)', () => {
  assert.equal(TUI.classifyTuiComposer('claude', facts(fixture('claude-draft'))).cls, 'DRAFT');
  assert.equal(TUI.classifyTuiComposer('claude', facts(fixture('claude-draft')), TEXT).cls, 'DRAFT', 'someone else\'s draft');
  assert.equal(TUI.classifyTuiComposer('claude', facts(fixture('claude-draft')), 'hello').cls, 'READY_OWN_DRAFT');
  assert.equal(TUI.classifyTuiComposer('claude', facts(fixture('claude270-staged')), 'ZQS44JHAQZ').cls, 'READY_OWN_DRAFT');
  assert.equal(TUI.classifyTuiComposer('antigravity', facts(fixture('agy127-staged')), 'ZQSSSW5FQZ').cls, 'READY_OWN_DRAFT');
  assert.equal(TUI.classifyTuiComposer('antigravity', facts(fixture('agy127-staged'))).cls, 'DRAFT');
});

test('(a) a provider\'s screen is not the other\'s composer (the glyph is per provider)', () => {
  assert.notEqual(TUI.classifyTuiComposer('antigravity', facts(fixture('claude-idle-120x40'))).cls, 'READY');
  assert.notEqual(TUI.classifyTuiComposer('claude', facts(fixture('agy127-boot'))).cls, 'READY');
});

test('(a) a select list drawn under the box (slash-command completion) is never READY', () => {
  const fx = fixture('claude-idle-120x40');
  for (const extra of [['  ❯ 1. /compact', '    2. /clear'], ['  ❯ 1. /compact']]) {
    const lines = [...fx.lines, ...extra];
    const f = SHARED.extractCodexScreen((i) => lines[i], lines.length, fx.cursorRow);
    assert.equal(TUI.classifyTuiComposer('claude', f).cls, 'MODAL', JSON.stringify(extra));
  }
});

test('(a) footer allowlist (Andy SHOULD-1): an UNNUMBERED completion list under the box is never READY nor ours; every real footer is', () => {
  // Claude's slash-command and @-path completions are unnumbered rows under the box (DERIVED
  // shapes: no capture yet). Only the footer rows the REAL captures show are allowed there.
  const text = '/compact the context';
  for (const extra of [['  /compact   Clear conversation history but keep a summary'], ['  @src/', '  @src/main/'], ['  Auto-update failed']]) {
    for (const prov of ['claude', 'antigravity']) {
      const fx = prov === 'claude' ? fixture('claude-idle-120x40') : fixture('agy127-boot');
      const idle = { ...fx, lines: [...fx.lines, ...extra] };
      const staged = withComposer(fx, prov, text); staged.lines = [...staged.lines, ...extra];
      const read = (x) => SHARED.extractCodexScreen((i) => x.lines[i], x.lines.length, x.cursorRow);
      assert.notEqual(TUI.classifyTuiComposer(prov, read(idle)).cls, 'READY', `${prov} STAGE ${JSON.stringify(extra)}`);
      assert.notEqual(TUI.classifyTuiComposer(prov, read(staged), text).cls, 'READY_OWN_DRAFT', `${prov} COMMIT ${JSON.stringify(extra)}`);
    }
  }
  for (const name of ['claude-idle-120x40', 'claude-idle-80x24', 'claude-hive-statusline-boot', 'claude-hive-statusline-idle', 'claude-rc', 'claude-rc-notice', 'claude270-boot', 'claude270-afterclear', 'agy127-boot', 'agy127-afterclear']) {
    const prov = name.startsWith('agy') ? 'antigravity' : 'claude';
    assert.equal(TUI.classifyTuiComposer(prov, facts(fixture(name))).cls, 'READY', `${name}: its real footer is allowed`);
  }
});

test('(a) agy readiness needs real output: hasOutput=false is not ready (0398e918 had exempted agy)', () => {
  for (const p of ['antigravity', 'claude', 'codex']) {
    assert.equal(PA.terminalReadyToReceive(false, 60_000, p), false, `${p}: nothing drawn = not ready`);
    assert.equal(PA.terminalReadyToReceive(true, 60_000, p), true, `${p}: drawn and settled = ready`);
  }
});

// ─── (b) the real owner through the real wiring ──────────────────────────────────────────

/** `fx` with its composer box holding `text` (what the TUI echoes after the owner stages). */
function withComposer(fx, prov, text) {
  const rules = [];
  fx.lines.forEach((l, i) => { if (RULE.test(l)) rules.push(i); });
  const [top, bottom] = rules.slice(-2);
  assert.ok(bottom > top, 'fixture has a composer box');
  const lines = [...fx.lines.slice(0, top + 1), `${GLYPH[prov]} ${text}`, ...fx.lines.slice(bottom)];
  return { ...fx, lines, cursorRow: top + 1 };
}

function rig(over = {}) {
  const r = {
    now: T0, mono: 0, seq: 0, timers: [], writes: [], guard: [], interfered: [],
    provider: 'claude', screen: 'claude-idle-120x40', dir: FX, afterStage: null, prompt: '', readings: 0,
    session: { incarnation: 1, gen: 0, lastHumanAt: undefined, hasOutput: true,
      inputState: { mouseTrackingMode: 'none', inputOriginAttached: true, selfTest: 'pass' },
      promptState: { block: null } },
    ...over
  };
  const setTimer = (fn, ms) => { const t = { at: r.now + ms, seq: (r.seq += 1), fn, ms }; r.timers.push(t); return { id: t.seq, unref() { return this; } }; };
  r.tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => r.now, () => r.mono);
  r.runtime = new CapacityRuntime({
    deliver: () => {}, now: () => r.now, setTimer, log: () => {},
    clearTimer: (h) => { r.timers = r.timers.filter((t) => t.seq !== (h && h.id)); }
  }, r.tracker);
  r.view = () => {
    if (r.prompt && r.afterStage) return fixture(r.afterStage);
    const fx = fixture(r.screen, r.dir);
    return r.prompt ? withComposer(fx, r.provider, r.prompt) : fx;
  };
  r.pty = {
    write: (id, data, origin) => {
      assert.equal(origin, 'PROGRAMMATIC');
      r.writes.push(data);
      if (data === '\r' || data === '\x15') r.prompt = ''; else r.prompt += data;
      r.out += 1;
      return { ok: true };
    },
    incarnation: () => r.session.incarnation,
    humanInputGeneration: () => r.session.gen,
    lastHumanInputAt: () => r.session.lastHumanAt,
    hasOutput: () => r.session.hasOutput,
    inputState: () => r.session.inputState,
    promptState: () => r.session.promptState,
    outputGeneration: () => r.out,
    spawnCwd: () => undefined
  };
  r.out = 1;
  r.deps = buildOwnerDeps({
    pty: r.pty, capacity: r.runtime,
    ptyForAgent: (agentId) => (agentId === 'jim' ? 'pty-jim' : undefined),
    providerForPty: () => r.provider,
    requestScreenReading: (ptyId, needle) => {
      const on = r.forceOnPromptRow || r.prompt.includes(needle);
      return Promise.resolve({ onPromptRow: on, screenCount: on ? 1 : 0 });
    },
    requestCodexScreen: (ptyId, expectedTail) => {
      r.readings += 1;
      const codex = facts(r.view());
      return Promise.resolve({ onPromptRow: false, screenCount: 0, codex,
        ...(expectedTail ? { promptTailMatches: r.prompt.endsWith(expectedTail) } : {}) });
    },
    onScreenGuard: (rec) => r.guard.push(rec),
    onInterfered: (rec) => r.interfered.push(rec),
    now: () => r.now, setTimer
  });
  r.owner = new AutomaticSubmitOwner(r.deps);
  r.settle = async (promise) => {
    let done = false; let value;
    promise.then((v) => { done = true; value = v; });
    for (let i = 0; i < 5000; i += 1) {
      await new Promise((res) => setImmediate(res));
      if (done) return value;
      assert.ok(r.timers.length, 'stuck: unsettled and no timer pending');
      r.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = r.timers.shift();
      const dt = Math.max(0, next.at - r.now);
      r.now += dt; r.mono += dt;
      next.fn();
    }
    throw new Error('did not settle');
  };
  r.submit = (id = 'w1', cls = 'CAPACITY_GATED') => r.settle(r.owner.submit({ requestId: id, agentId: 'jim', admissionClass: cls, text: TEXT }));
  return r;
}

test('(b) wiring: claude and antigravity are ENFORCE, and the owner is told the provider', () => {
  for (const p of ['claude', 'antigravity', 'codex']) {
    const r = rig({ provider: p });
    assert.equal(r.deps.screenGuard('pty-jim'), 'ENFORCE', p);
    assert.equal(r.deps.screenProvider('pty-jim'), p);
  }
  assert.equal(rig({ provider: 'opencode' }).deps.screenGuard('pty-jim'), 'OFF', 'other providers unchanged');
});

test('(b) R1-R5: on every dialog the real owner refuses SCREEN_NOT_READY and writes ZERO bytes, for every admission class', async () => {
  for (const [prov, name] of DIALOGS) {
    const r = rig({ provider: prov, screen: name });
    for (const cls of ['CAPACITY_GATED', 'USER_RELEASED', 'BOOT_SEQUENCE']) {
      const out = await r.submit(`${name}-${cls}`, cls);
      assert.equal(out.kind, 'REFUSED', `${name} ${cls}: refused (got ${JSON.stringify(out)})`);
      assert.equal(out.reason, 'SCREEN_NOT_READY', `${name} ${cls}`);
    }
    assert.deepEqual(r.writes, [], `${name}: NO BYTE was written (no text, no Enter, no Ctrl-U)`);
    assert.ok(r.readings > 0, `${name}: the screen was really read`);
    // Surfacing: every refusal is a screen-guard row (the 5-min hive:integrity notice and the
    // composer's screenHold badge are built from these rows; the wake retries with backoff).
    assert.ok(r.guard.length > 0 && r.guard.every((g) => g.ok === false || g.verdict === 'REFUSE' || g.reason), `${name}: every refusal is logged`);
  }
});

test('(b) positives: on every REAL idle composer the real owner delivers the nudge (text, then Enter)', async () => {
  for (const [prov, name] of IDLE) {
    const r = rig({ provider: prov, screen: name });
    const out = await r.submit('w1');
    assert.equal(out.kind, 'COMMITTED', `${name}: delivered (got ${JSON.stringify(out)})`);
    assert.deepEqual(r.writes, [TEXT, '\r'], `${name}: exactly the text and one Enter`);
  }
});

test('(b) a person\'s draft is never typed over: STAGE is refused with zero bytes (REAL claude-draft)', async () => {
  const r = rig({ provider: 'claude', screen: 'claude-draft' });
  const out = await r.submit('w1');
  assert.equal(out.kind, 'REFUSED');
  assert.deepEqual(r.writes, []);
});

test('(b) G6: a dialog that opens after STAGE gets no Enter and no Ctrl-U; it is held SCREEN_DIALOG_OPEN', async () => {
  for (const [prov, screen, dialog] of [['claude', 'claude-idle-120x40', 'claude-rate-limit'], ['antigravity', 'agy127-boot', 'agy-settings-error'], ['claude', 'claude-rc', 'claude-rc-dialog']]) {
    const r = rig({ provider: prov, screen, afterStage: dialog, forceOnPromptRow: true });
    const out = await r.submit('w1');
    assert.deepEqual(r.writes, [TEXT], `${dialog}: after the stage write, no Enter and no erase`);
    assert.equal(out.kind, 'INTERFERED', `${dialog}: held for a person (got ${JSON.stringify(out)})`);
    assert.ok(!r.writes.includes('\x15') && !r.writes.includes('\r'));
    assert.equal(out.reason, 'SCREEN_DIALOG_OPEN', `${dialog}: the erase was refused by the G6 check`);
    assert.match(out.detail, new RegExp(`^MODAL:${prov}-dialog:`), `${dialog}: it names the dialog`);
    assert.equal(r.interfered.at(-1).reason, 'SCREEN_DIALOG_OPEN', 'surfaced as an INTERFERED record (held for a person)');
  }
});

test('(a) own-draft-clipped: our own long wake text that wraps past the 24-row tail is ours at COMMIT, never at STAGE, never with a dialog', () => {
  // The wake nudge names every pending id; at 80 columns 60 ids wrap to ~26 rows, so the box's
  // top rule and glyph scroll above the reading (DERIVED: the box shape of the REAL idle captures).
  const ids = Array.from({ length: 60 }, (_, i) => `2026-10-17T08-${String(i).padStart(2, '0')}-00-000Z-abc${i}`);
  const own = `You have new hive mail (delivered in context below): ${ids.join(' ')}`;
  const rule = '─'.repeat(80);
  const screen = (prov, text, mutate = (r) => r, footer = ['  ? for shortcuts']) => {
    const wrapped = `${GLYPH[prov]} ${text}`.match(/.{1,78}/g);
    const lines = ['header', '', rule, ...mutate(wrapped), rule, ...footer];
    return SHARED.extractCodexScreen((i) => lines[i], lines.length, lines.length - 1);
  };
  for (const prov of ['claude', 'antigravity']) {
    const f = screen(prov, own);
    assert.ok(!f.tail.includes(rule) || f.tail.indexOf(rule) === f.tail.lastIndexOf(rule), `${prov}: the top rule is out of the tail`);
    assert.equal(TUI.tuiComposerBox(prov, f.tail), null, `${prov}: no whole box in the reading`);
    assert.deepEqual(TUI.classifyTuiComposer(prov, f, own), { cls: 'READY_OWN_DRAFT', reason: 'own-draft-clipped' }, `${prov}: our clipped text`);
    assert.notEqual(TUI.classifyTuiComposer(prov, f).cls, 'READY', `${prov}: STAGE never takes a clipped box as empty`);
    assert.notEqual(TUI.classifyTuiComposer(prov, f, own.replace('abc59', 'abd59')).cls, 'READY_OWN_DRAFT', `${prov}: different text is not ours`);
    const dialog = screen(prov, own, (r) => [...r.slice(0, -3), 'Do you trust the files in this folder?', ...r.slice(-3)]);
    assert.notEqual(TUI.classifyTuiComposer(prov, dialog, own).cls, 'READY_OWN_DRAFT', `${prov}: a dialog row among the rows is never ours`);
    const below = screen(prov, own, undefined, ['  ❯ 1. Yes, continue', '    2. No, exit']);
    assert.notEqual(TUI.classifyTuiComposer(prov, below, own).cls, 'READY_OWN_DRAFT', `${prov}: a select list under the box owns Enter`);
    const completion = screen(prov, own, undefined, ['  ? for shortcuts', '  @src/']);
    assert.notEqual(TUI.classifyTuiComposer(prov, completion, own).cls, 'READY_OWN_DRAFT', `${prov}: an unnumbered completion row under the box is not a footer`);
    const short = SHARED.extractCodexScreen((i) => [own.slice(-120), rule, '  ? for shortcuts'][i], 3, 2);
    assert.notEqual(TUI.classifyTuiComposer(prov, short, own).cls, 'READY_OWN_DRAFT', `${prov}: a short suffix proves nothing`);
  }
});

test('R4 control: Codex is unchanged: its trust screen is refused with zero bytes by its own allowlist', async () => {
  for (const name of ['1-untrusted-trust-120x40', '1-untrusted-trust-80x24']) {
    const r = rig({ provider: 'codex', screen: name, dir: WSG });
    assert.equal(r.deps.screenGuard('pty-jim'), 'ENFORCE');
    const out = await r.submit('w1');
    assert.equal(out.kind, 'REFUSED', `${name}: ${JSON.stringify(out)}`);
    assert.deepEqual(r.writes, [], `${name}: zero bytes`);
    assert.ok(!r.guard.some((g) => /claude|antigravity/.test(String(g.reason))), 'judged by the Codex rules, not the TUI ones');
  }
});

test('surfacing: a claude dialog that keeps refusing the wake raises the hive:integrity notice and the screenHold flag, and the idle composer lifts both', async () => {
  const { ScreenGuardNotices, SCREEN_GUARD_ALERT_MS } = loadTs('src/main/codexScreenGuard.ts');
  const raised = []; const cleared = [];
  const notices = new ScreenGuardNotices({ raise: (a) => raised.push(a), clear: (id) => cleared.push(id) });
  const r = rig({ provider: 'claude', screen: 'claude-rate-limit' });
  // index.ts wires every screen-guard row into the notices, exactly like this.
  r.deps.onScreenGuard = (g) => { r.guard.push(g); notices.reading(g.agentId, g.ok, g.reason, g.admissionClass === 'CAPACITY_GATED', r.now); };
  r.owner = new AutomaticSubmitOwner(r.deps);
  const start = r.now;
  for (let i = 0; r.now - start <= SCREEN_GUARD_ALERT_MS + 60_000; i += 1) {
    const out = await r.submit(`w${i}`);
    assert.equal(out.kind, 'REFUSED');
    assert.ok(notices.hold('jim', r.now), 'the composer shows the screen-check hold while it refuses');
    r.now += 30_000;                                // the wake retries (the drain asks again)
  }
  assert.deepEqual(r.writes, [], 'never a byte into the dialog');
  assert.equal(raised.length, 1, 'ONE visible notice after the alert window, not a silent stall');
  assert.match(raised[0].reason, /claude-dialog:What do you want to do\?/, 'the notice names the dialog');
  assert.deepEqual(cleared, [], 'nothing lifts it while the dialog stands');
  r.screen = 'claude-idle-120x40';
  const ok = await r.submit('wok');
  assert.equal(ok.kind, 'COMMITTED', 'the dialog gone, the next retry delivers');
  assert.ok(cleared.length > 0 && cleared.every((id) => id === 'jim'), 'and the notice is lifted (each ok reading lifts)');
  assert.equal(notices.hold('jim', r.now), null);
});

test('every Claude agent spawns with prompt suggestions off (env + settings), so its idle composer is never ghost text', async (t) => {
  const os = require('node:os');
  const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tui191-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = FAKE_HOME; process.env.USERPROFILE = FAKE_HOME;
  assert.equal(os.homedir(), FAKE_HOME, 'HOME redirect failed - aborting before touching ~/.claude');
  const { HiveManager } = loadTs('src/main/hive.ts');
  const harness = fs.mkdtempSync(path.join(FAKE_HOME, 'harness-'));
  const hive = new HiveManager(() => harness);
  t.after(() => {
    hive.dispose();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(FAKE_HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  for (const meta of [{ id: 'god', name: 'Michael', provider: 'claude', cwd: FAKE_HOME, isGod: true }, { id: 'jim-x', name: 'Jim', provider: 'claude', cwd: FAKE_HOME }]) {
    const inj = await hive.ensureAgent(meta);
    assert.equal(inj.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, 'false', meta.id);
    const i = inj.args.indexOf('--settings');
    assert.equal(JSON.parse(fs.readFileSync(inj.args[i + 1], 'utf8')).promptSuggestionEnabled, false, meta.id);
  }
});

// ─── COMPOSER-FOOTER-HOTFIX-191: Guppy's own statusline under the box ───────────────────

/** The footer rows of the live refusals (hive/log.jsonl wake-screen-guard rows, 1.1.91 at about
 *  11:25Z-12:58Z on 2026-10-18): the trimmed rows under the cursor. */
const LIVE_FOOTERS = [
  ['ctx 179k/1000k (18%)', '⏵⏵ bypass permissions on (shift+tab to cycle)'],
  ['ctx 0k/1000k (0%)', '⏵⏵ bypass permissions on (shift+tab to cycle)']
];
/** A REAL hive screen with its rows under the closing rule replaced. */
function withFooter(name, rows) {
  const fx = fixture(name);
  const bottom = fx.lines.findLastIndex((l) => RULE.test(l));
  return { ...fx, lines: [...fx.lines.slice(0, bottom + 1), ...rows] };
}
const read = (x) => SHARED.extractCodexScreen((i) => x.lines[i], x.lines.length, x.cursorRow);

test('HOTFIX-191: the REAL hive screens (ctx statusline under the box) are READY and latch condition 1', () => {
  for (const name of ['claude-hive-statusline-boot', 'claude-hive-statusline-idle']) {
    const fx = fixture(name);
    assert.ok(fx.lines.some((l) => /^\s*ctx \d+k\/\d+k \(\d+%\)/.test(l)), `${name}: the capture holds the statusline row`);
    const out = TUI.classifyTuiComposer('claude', facts(fx));
    assert.deepEqual(out, { cls: 'READY', reason: 'empty-composer' }, name);
    assert.deepEqual(TUI.tuiPastStartup(out), { open: true, reason: 'composer-seen' }, name);
  }
  // The rows of the live refusals, as the log kept them (column 0, no right side).
  for (const rows of LIVE_FOOTERS) {
    assert.equal(TUI.classifyTuiComposer('claude', read(withFooter('claude-hive-statusline-idle', rows))).cls, 'READY', JSON.stringify(rows));
  }
});

test('HOTFIX-191: our own staged text above the statusline is READY_OWN_DRAFT (COMMIT is not refused)', () => {
  const staged = withComposer(fixture('claude-hive-statusline-idle'), 'claude', TEXT);
  assert.equal(TUI.classifyTuiComposer('claude', read(staged), TEXT).cls, 'READY_OWN_DRAFT');
  assert.equal(TUI.classifyTuiComposer('claude', read(staged)).cls, 'DRAFT', 'someone else\'s text is still a draft');
});

test('HOTFIX-191: the statusline allowance is the gauge only; a list or a notice under it is still refused', () => {
  const ctx = '  ctx 42k/1000k (4%)';
  const mode = '  ⏵⏵ bypass permissions on (shift+tab to cycle)';
  // A completion list drawn under the box with the statusline: never READY.
  for (const extra of [['  ❯ 1. /compact', '    2. /clear'], ['  /compact   Clear conversation history but keep a summary'], ['  @src/', '  @src/main/'], ['  Auto-update failed']]) {
    const out = TUI.classifyTuiComposer('claude', read(withFooter('claude-hive-statusline-idle', [ctx, ...extra])));
    assert.notEqual(out.cls, 'READY', JSON.stringify(extra));
  }
  assert.equal(TUI.classifyTuiComposer('claude', read(withFooter('claude-hive-statusline-idle', [ctx, '  ❯ 1. /compact']))).cls, 'MODAL');
  // Rows that only look like the gauge are not it.
  for (const row of ['  ctx is high', '  ctx 42k/1000k (4%)/compact', '  ctx 42k/1000k (4%) x', '  @ctx 42k/1000k (4%)', '  ctx 42k/1000k']) {
    const out = TUI.classifyTuiComposer('claude', read(withFooter('claude-hive-statusline-idle', [row, mode])));
    assert.equal(out.cls, 'UNKNOWN', row);
    assert.match(out.reason, /^footer-row:/, row);
  }
  // Four rows under the box (statusline, mode line, status, notice) are a footer; five are not.
  const four = [ctx, mode, '                                                  ◐ medium · /effort', 'Remote Control disconnected'];
  assert.equal(TUI.classifyTuiComposer('claude', read(withFooter('claude-hive-statusline-idle', four))).cls, 'READY');
  assert.notEqual(TUI.classifyTuiComposer('claude', read(withFooter('claude-hive-statusline-idle', [...four, '  ⏵⏵ bypass permissions on']))).cls, 'READY');
});

test('HOTFIX-191: a startup refusal names the class and reason the composer check gave, not a bare no-composer', () => {
  assert.deepEqual(TUI.tuiPastStartup({ cls: 'UNKNOWN', reason: 'footer-row:ctx 1k' }), { open: false, reason: 'UNKNOWN:footer-row:ctx 1k' });
  assert.deepEqual(TUI.tuiPastStartup({ cls: 'MODAL', reason: 'claude-dialog:Do you trust' }), { open: false, reason: 'MODAL:claude-dialog:Do you trust' });
  for (const cls of ['READY', 'READY_OWN_DRAFT', 'DRAFT']) assert.equal(TUI.tuiPastStartup({ cls, reason: 'x' }).open, true, cls);
});

test('HOTFIX-191 (b): the real owner delivers on the live footer shape, and an unknown row is refused with its own reason logged', async () => {
  for (const rows of LIVE_FOOTERS) {
    const r = rig({ provider: 'claude', screen: 'claude-hive-statusline-idle' });
    const base = r.view;
    r.view = () => { const fx = base(); const bottom = fx.lines.findLastIndex((l) => RULE.test(l)); return { ...fx, lines: [...fx.lines.slice(0, bottom + 1), ...rows] }; };
    const out = await r.submit('w1');
    assert.equal(out.kind, 'COMMITTED', `${JSON.stringify(rows)}: delivered (got ${JSON.stringify(out)})`);
    assert.deepEqual(r.writes, [TEXT, '\r']);
  }
  const r = rig({ provider: 'claude', screen: 'claude-hive-statusline-idle' });
  r.view = () => withFooter('claude-hive-statusline-idle', ['  Auto-update failed', '  ⏵⏵ bypass permissions on (shift+tab to cycle)']);
  const out = await r.submit('w1');
  assert.equal(out.kind, 'REFUSED');
  assert.deepEqual(r.writes, []);
  const reasons = r.guard.map((g) => g.reason);
  assert.ok(reasons.includes('startup:UNKNOWN:footer-row:Auto-update failed'), `the guard row names the row it refused: ${JSON.stringify(reasons)}`);
  assert.ok(!reasons.includes('startup:no-composer'), 'never the bare no-composer');
});
