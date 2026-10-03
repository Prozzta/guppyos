'use strict';
/**
 * READS-MAIL-CAP (1.1.83): long mail injected into god's turns arrives as its first ~1,500
 * characters plus the file paths (inbox/ now, inbox/.done/ after the turn), so the rest stays fully
 * readable on demand. The Human's and the harness's mail is never shortened (an ephemeral worker's
 * Slack reply line sits at the END of its body). Other agents are uncapped unless their registry
 * entry sets `mailCapChars`. The builder is pure; the hook paths run a real HookServer against a
 * real (jailed) hive.
 *
 * HOME, USERPROFILE, CODEX_HOME and GEMINI_CLI_HOME are jailed and asserted before any hive is built.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mail-cap-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL; process.env.CODEX_HOME = path.join(JAIL, '.codex'); process.env.GEMINI_CLI_HOME = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const S = loadTs('src/main/mailSurface.ts');
const { ALWAYS_WAKE_SENDERS } = loadTs('src/shared/mailWakeClass.ts');
const { HookServer } = loadTs('src/main/hooks.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

// ————————————————————————————————————————————————————————————— pure pieces

let seqN = 0;
function entry(over = {}) {
  seqN += 1;
  return {
    id: `m${seqN}`, from: 'jim-1', act: 'inform', subject: `subject ${seqN}`, bodyHash: 'h', via: 'inbox', state: 'delivered',
    seq: seqN, deliveredAt: 1_000 + seqN, surfaceCount: 0, unconfirmedSurfacings: 0, redelivered: false, legacy: false,
    requiresReply: false, updatedAt: 1_000 + seqN, ...over
  };
}
const P = (id) => `C:\\hive\\agents\\god-1\\inbox\\${id}.json`;
const D = (id) => `C:\\hive\\agents\\god-1\\inbox\\.done\\${id}.json`;
const item = (id, body, cap) => ({ entry: entry({ id }), body, path: P(id), ...(cap === undefined ? {} : { cap }) });
const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');   // never repeats; words(1_100) = 5,489 characters
const markersIn = (text) => [...(text ?? '').matchAll(/\[hive-mail:([^\]]+)\]/g)].map((m) => m[1]);

test('effectiveMailCap: god 1,500 by default; config sets or switches it off; an agent\'s own value wins; others uncapped', () => {
  assert.equal(S.GOD_MAIL_CAP_DEFAULT, 1_500);
  assert.equal(S.effectiveMailCap(undefined, undefined, true), 1_500);
  assert.equal(S.effectiveMailCap(undefined, 3_000, true), 3_000);
  assert.equal(S.effectiveMailCap(undefined, 0, true), 0, 'config 0 = off');
  assert.equal(S.effectiveMailCap(0, 3_000, true), 0, 'own 0 wins');
  assert.equal(S.effectiveMailCap(2_000, undefined, true), 2_000);
  assert.equal(S.effectiveMailCap(undefined, 3_000, false), 0, 'not god: the god setting does not apply');
  assert.equal(S.effectiveMailCap(2_000, undefined, false), 2_000, 'any agent may opt in');
  for (const bad of [-1, Number.NaN, '1500', null, Infinity]) {
    assert.equal(S.effectiveMailCap(bad, undefined, true), 1_500, `own ${String(bad)} ignored`);
    assert.equal(S.effectiveMailCap(undefined, bad, true), 1_500, `config ${String(bad)} ignored`);
  }
});

test('mailCapExempt: the Human, voice, the digest, the breaker and every harness sender (the wake set) are never capped', () => {
  for (const s of ['human', 'michael-voice', 'ephemeral-worker', 'digest', 'breaker', 'system', 'heartbeat', 'scheduler', 'webhook']) {
    assert.equal(S.mailCapExempt(s, ALWAYS_WAKE_SENDERS), true, s);
  }
  for (const s of ['jim-1', 'andy-mtuk4y4x', 'creed']) assert.equal(S.mailCapExempt(s, ALWAYS_WAKE_SENDERS), false, s);
});

test('mailCapCut: whole under cap + 500; otherwise at a line break or space inside the last 200 characters; never splits an escape', () => {
  assert.equal(S.mailCapCut('x'.repeat(1_999), 1_500), null, 'saves under 500: whole');
  assert.equal(S.mailCapCut('x'.repeat(5_000), 0), null, 'cap 0 = off');
  assert.equal(S.mailCapCut('x'.repeat(5_000), undefined), null);
  assert.equal(S.mailCapCut('x'.repeat(5_000), 1_500), 1_500, 'no break nearby: the cap itself');
  const nl = 'a'.repeat(1_400) + '\n' + 'b'.repeat(3_000);
  assert.equal(S.mailCapCut(nl, 1_500), 1_400, 'the line break');
  const far = 'a'.repeat(1_000) + '\n' + 'b'.repeat(3_000);
  assert.equal(S.mailCapCut(far, 1_500), 1_500, 'a break 500 back is too far');
  const sp = S.mailCapCut(words(1_100), 1_500);
  assert.ok(sp <= 1_500 && sp >= 1_300 && words(1_100)[sp] === ' ', `space cut ${sp}`);
  const esc = 'x'.repeat(1_498) + '&lt;' + 'y'.repeat(3_000);
  assert.equal(S.mailCapCut(esc, 1_500), 1_498, 'backs off before &lt;');
});

test('handledMailPath: names the inbox/.done/ twin (either separator); a .done path has none', () => {
  assert.equal(S.handledMailPath(P('x')), D('x'));
  assert.equal(S.handledMailPath('/h/agents/a/inbox/x.json'), '/h/agents/a/inbox/.done/x.json');
  assert.equal(S.handledMailPath(D('x')), null);
  assert.equal(S.handledMailPath('x.json'), null);
});

test('builder: a capped 6,000-character body shows ~1,500 characters plus BOTH paths, is claimed (surfacing) and listed as capped, not truncated', () => {
  const body = words(1_100);
  const blk = S.buildMailBlock({ items: [item('big', body, 1_500)], budget: 9_500, phase: 'turn-start' });
  assert.deepEqual(blk.surfacing, ['big']);
  assert.deepEqual(blk.capped, ['big']);
  assert.deepEqual(blk.truncated, []);
  assert.ok(blk.text.length < 2_200, `block ${blk.text.length}`);
  assert.ok(blk.text.includes(body.slice(0, 1_300)), 'the head of the body');
  assert.ok(!blk.text.includes(body.slice(1_600, 1_700)), 'not the rest');
  assert.ok(blk.text.includes(`[... shortened: ${body.length} characters in total. Read the rest in ${P('big')} (after this turn: ${D('big')}) when you need it]`));
  // Uncapped (no cap on the item): whole, as before.
  const whole = S.buildMailBlock({ items: [item('w', body)], budget: 9_500, phase: 'turn-start' });
  assert.deepEqual(whole.capped, []);
  assert.ok(whole.text.includes(body));
});

test('builder: a body just over the cap (saving under 500) is sent whole', () => {
  const body = 'z'.repeat(1_900);
  const blk = S.buildMailBlock({ items: [item('j', body, 1_500)], budget: 9_500, phase: 'turn-start' });
  assert.deepEqual(blk.capped, []);
  assert.ok(blk.text.includes(body));
});

test('builder: three 6,000-character messages that used to drip over three hooks all surface in ONE capped block', () => {
  const its = ['a', 'b', 'c'].map((id) => item(id, words(1_100), 1_500));
  const blk = S.buildMailBlock({ items: its, budget: 9_500, phase: 'turn-start' });
  assert.deepEqual(blk.surfacing, ['a', 'b', 'c']);
  assert.deepEqual(blk.capped, ['a', 'b', 'c']);
  assert.deepEqual(blk.deferred, []);
  const uncapped = S.buildMailBlock({ items: ['a', 'b', 'c'].map((id) => item(`u${id}`, words(1_100))), budget: 9_500, phase: 'turn-start' });
  assert.deepEqual(uncapped.surfacing, ['ua'], 'without the cap only one fits');
});

test('builder: the compact re-injection is capped the same way', () => {
  const blk = S.buildMailBlock({ items: [item('k', words(1_100), 1_500)], budget: 9_500, phase: 'compact' });
  assert.deepEqual(blk.capped, ['k']);
  assert.match(blk.text, /Your context was compacted\./);
  assert.ok(blk.text.length < 2_300);
});

test('builder: a budget truncation of a capped item never shows more than the cap', () => {
  // Budget 1,500: even the capped render does not fit whole, so the budget truncates it (the
  // Math.min with the cap is defensive: at real budgets the budget cut is the shorter one).
  const body = 'q'.repeat(9_000);
  const blk = S.buildMailBlock({ items: [item('t', body, 1_200)], budget: 1_500, phase: 'turn-start' });
  assert.deepEqual(blk.surfacing, ['t']);
  assert.deepEqual(blk.truncated, ['t'], 'the budget path');
  assert.deepEqual(blk.capped, []);
  const shown = (blk.text.match(/q+/g) ?? []).reduce((n, s) => Math.max(n, s.length), 0);
  assert.ok(shown <= 1_200, `shown ${shown}`);
  assert.ok(blk.text.includes(D('t')), 'names the .done path too');
});

// ————————————————————————————————————————————————————————————— hooks (real hive, jailed)

async function floor(t, cfg = {}) {
  const home = fs.mkdtempSync(path.join(JAIL, 'floor-'));
  const hive = new HiveManager(() => home, () => true);
  const server = { current: null };
  t.after(() => { try { server.current?.stop(); } catch { /* noop */ } hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'cl-1', name: 'cl-1', provider: 'claude', cwd: home });
  const own = {};
  const reg = hive.registry.bind(hive);
  hive.registry = () => { const r = reg(); for (const [id, v] of Object.entries(own)) r.agents[id] = { ...r.agents[id], mailCapChars: v }; return r; };
  const control = { takeSteer: () => null, shouldHalt: () => false, toolDecision: () => ({ deny: false }) };
  const s = new HookServer(hive, () => null, () => ({ notifications: false, ...cfg }), control, undefined, undefined, () => {});
  server.current = s;
  const fire = (agent_id, hook_event_name, extra = {}) => s.handle({ agent_id, hook_event_name, session_id: `s-${agent_id}`, ...extra });
  const ctx = (res) => res?.hookSpecificOutput?.additionalContext ?? '';
  const logRows = () => { try { return fs.readFileSync(path.join(hive.root(), 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { hive, fire, ctx, logRows, own };
}

test('hooks: god gets an agent\'s long mail capped with both paths; the inbox file holds the whole body; a mail-capped row is logged', async (t) => {
  const f = await floor(t);
  const body = words(1_100) + '\nTHE-TAIL-MARKER';
  const m = f.hive.send({ to: 'god-1', act: 'inform', subject: 'long', body }, 'jim-1');
  const c = f.ctx(f.fire('god-1', 'UserPromptSubmit', { prompt: 'go' }));
  assert.deepEqual(markersIn(c), [m.id]);
  assert.ok(!c.includes('THE-TAIL-MARKER'), 'the tail is not in context');
  const inbox = path.join(f.hive.root(), 'agents', 'god-1', 'inbox');
  const file = path.join(inbox, `${m.id}.json`);
  assert.ok(c.includes(`Read the rest in ${file} (after this turn: ${path.join(inbox, '.done', `${m.id}.json`)}) when you need it]`), c.slice(-400));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).body, body, 'no lost function: the whole body is on disk');
  const row = f.logRows().find((r) => r.kind === 'mail-capped' && r.id === m.id);
  assert.ok(row, 'mail-capped row');
  assert.equal(row.agentId, 'god-1');
  assert.equal(row.cap, 1_500);
  assert.equal(row.bodyChars, body.length);
});

test('hooks: the Human\'s and an ephemeral worker\'s long mail reaches god whole (the Slack reply line at the end survives)', async (t) => {
  const f = await floor(t);
  const tail = '\nReply: "C:\\hive\\bin\\hive-node.cmd" "helper" --channel C1 --thread 1.2 --text "..."';
  const a = f.hive.send({ to: 'god-1', act: 'inform', subject: 'worker failed', body: words(1_500) + tail }, 'ephemeral-worker');
  const c = f.ctx(f.fire('god-1', 'UserPromptSubmit', { prompt: 'go' }));
  assert.deepEqual(markersIn(c), [a.id]);
  assert.ok(c.includes('--thread 1.2 --text'), 'the reply line is in context');
  assert.ok(!c.includes('[... shortened:'));
  assert.equal(f.logRows().filter((r) => r.kind === 'mail-capped').length, 0);
});

test('hooks: other agents are uncapped by default; config 0 switches god off; a registry mailCapChars opts any agent in', async (t) => {
  const f = await floor(t, { godMailCapChars: 0 });
  const body = words(1_100);
  f.hive.send({ to: 'cl-1', act: 'inform', subject: 'long', body }, 'jim-1');
  assert.ok(f.ctx(f.fire('cl-1', 'UserPromptSubmit', { prompt: 'go' })).includes(body), 'cl-1 whole');
  f.hive.send({ to: 'god-1', act: 'inform', subject: 'long', body }, 'jim-1');
  assert.ok(f.ctx(f.fire('god-1', 'UserPromptSubmit', { prompt: 'go' })).includes(body), 'god off by config');
  f.own['cl-1'] = 2_000;
  f.hive.send({ to: 'cl-1', act: 'inform', subject: 'long2', body }, 'jim-1');
  const c = f.ctx(f.fire('cl-1', 'UserPromptSubmit', { prompt: 'again' }));
  assert.ok(!c.includes(body) && c.includes('[... shortened:'), 'cl-1 opted in');
});

test('hooks: after a compaction the re-injected long mail is capped too', async (t) => {
  const f = await floor(t);
  const body = words(1_100) + '\nTHE-TAIL-MARKER';
  const m = f.hive.send({ to: 'god-1', act: 'inform', subject: 'long', body }, 'jim-1');
  f.fire('god-1', 'UserPromptSubmit', { prompt: 'go' });
  const c = f.ctx(f.fire('god-1', 'SessionStart', { source: 'compact' }));
  assert.deepEqual(markersIn(c), [m.id]);
  assert.ok(c.includes('[... shortened:') && !c.includes('THE-TAIL-MARKER'));
});
