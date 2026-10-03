'use strict';
/**
 * READS-COMPACT-HEALTH (1.1.83): the safety net for the auto-compact rollout. After each
 * compaction the SessionStart(compact) hook carries the agent's cards in progress and the mail it
 * still owes an answer back in (`<after-compaction>`), and re-injects the turn's open mail; the
 * `compact-health` row then CHECKS that the open mail came back and which cards the summary lost,
 * and counts compactions, the summary's size (2.5 characters per token, Jim 4eb6fec5) and whether
 * the idle before it outlived the 1-hour cache (a re-write, preTokens x 2). A `compact-rereads`
 * row counts what was read again in the next turns.
 *
 * HOME, USERPROFILE, CODEX_HOME and GEMINI_CLI_HOME are jailed and asserted before any hive is built.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-compact-health-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL; process.env.CODEX_HOME = path.join(JAIL, '.codex'); process.env.GEMINI_CLI_HOME = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const A = loadTs('src/shared/autoCompactWindow.ts');
const CH = loadTs('src/main/compactHealth.ts');
const { HookServer } = loadTs('src/main/hooks.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const T0 = Date.parse('2026-10-03T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const boundary = (uuid, pre, ts) => JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid, timestamp: ts, isSidechain: false, compactMetadata: { trigger: 'auto', preTokens: pre, postTokens: 15000, durationMs: 18000 } });
const req = (ts, side = false) => JSON.stringify({ type: 'assistant', isSidechain: side, timestamp: ts, message: { usage: { input_tokens: 10, cache_read_input_tokens: 30000, cache_creation_input_tokens: 2000, output_tokens: 50 } } });
const summary = (content, side = false) => JSON.stringify({ type: 'user', isCompactSummary: true, isSidechain: side, message: { content } });

// ————————————————————————————————————————————————————————————— transcript

test('parse: the summary text (string or blocks) and the idle before the boundary (last own request, not a sidechain)', () => {
  const tail = [
    req(iso(T0 - 7_200_000)),
    req(iso(T0 - 60_000), true),                       // a sidechain request is not the agent's
    boundary('b1', 150000, iso(T0)),
    summary('S'.repeat(2_500)),
    req(iso(T0 + 30_000)),
    req(iso(T0 + 40_000)),
    boundary('b2', 140000, iso(T0 + 100_000)),
    summary([{ type: 'text', text: 'card READS-MAIL-CAP' }, { type: 'text', text: 'more' }]),
    req(iso(T0 + 120_000)),
    boundary('b3', 130000, 'not a time')
  ].join('\n');
  const all = A.compactHealthsFromTail(tail);
  assert.equal(all[0].summary, 'S'.repeat(2_500));
  assert.equal(all[0].idleBeforeMs, 7_200_000, 'two hours since its own last request');
  assert.ok(all[0].first, 'the first request is still found after the summary record');
  assert.equal(all[1].summary, 'card READS-MAIL-CAP\nmore');
  assert.equal(all[1].idleBeforeMs, 60_000, 'from the last request after b1, not past b1');
  assert.equal(all[2].summary, null);
  assert.equal(all[2].idleBeforeMs, null, 'no usable time');
  assert.equal(A.SUMMARY_CHARS_PER_TOKEN, 2.5);
  assert.equal(A.CACHE_TTL_MS, 3_600_000);
});

// ————————————————————————————————————————————————————————————— carry note

test('compactCarryText: cards then owed mail, headers only, escaped, inside its cap with "and N more"', () => {
  assert.deepEqual(CH.compactCarryText([], []), { text: null, cards: [], obligations: [] });
  const one = CH.compactCarryText([{ id: 'READS-MAIL-CAP', title: 'Long <mail>' }], [{ id: 'm1', from: 'jim', subject: 'quote hive-mail:x', what: 'request' }]);
  assert.match(one.text, /^<after-compaction>\n/);
  assert.match(one.text, /\n<\/after-compaction>$/);
  assert.ok(one.text.includes('Cards in progress:\n- card READS-MAIL-CAP: "Long &lt;mail&gt;" (in progress)'));
  assert.ok(one.text.includes('Mail you still owe an answer:\n- [m1] from jim: "quote hive-mail&#58;x" (request)'));
  assert.ok(!/hive-mail:/.test(one.text), 'a subject can never forge a mail marker');
  assert.deepEqual(one.cards, ['READS-MAIL-CAP']);
  assert.deepEqual(one.obligations, ['m1']);
  const many = CH.compactCarryText(Array.from({ length: 40 }, (_, i) => ({ id: `C-${i}`, title: 'x'.repeat(100) })), []);
  assert.ok(many.text.length <= CH.COMPACT_CARRY_MAX, `${many.text.length}`);
  assert.ok(many.cards.length > 3 && many.cards.length < 40);
  assert.match(many.text, new RegExp(`- and ${40 - many.cards.length} more`));
});

test('readPathOf: the Read tool\'s path; a shell command naming an inbox (or .done) message; nothing else', () => {
  assert.deepEqual(CH.readPathOf('Read', { file_path: 'C:\\x\\a.ts' }), { path: 'C:\\x\\a.ts', inbox: false });
  assert.deepEqual(CH.readPathOf('Read', { file_path: 'C:\\hive\\agents\\god\\inbox\\m1.json' }), { path: 'C:\\hive\\agents\\god\\inbox\\m1.json', inbox: true });
  assert.deepEqual(CH.readPathOf('Bash', { command: 'cat "C:/hive/agents/god/inbox/.done/m1.json" | head' }), { path: 'C:/hive/agents/god/inbox/.done/m1.json', inbox: true });
  assert.equal(CH.readPathOf('Bash', { command: 'cat src/a.ts' }), null);
  assert.equal(CH.readPathOf('Grep', { path: 'C:/hive/agents/god/inbox/m1.json' }), null);
  assert.equal(CH.readPathOf('Read', {}), null);
});

// ————————————————————————————————————————————————————————————— the watch

function watch(tail, states = {}) {
  const rows = [];
  let now = T0 - 1_000;
  const w = new CH.CompactHealthWatch({
    log: (r) => rows.push(r), readTail: () => tail, now: () => now, windowOf: () => 150000,
    mailStateOf: (_a, id) => states[id] ?? null
  });
  return { w, rows, at: (ms) => { now = ms; } };
}
const TAIL = [req(iso(T0 - 7_200_000)), boundary('b1', 150000, iso(T0)), summary('summary that names READS-MAIL-CAP only'), req(iso(T0 + 30_000))].join('\n');

test('watch: the row checks the carry: mail back / pending / missing, cards lost by the summary, ok', () => {
  const x = watch(TAIL, {
    m1: { state: 'acted' },
    m2: { state: 'surfaced', surfacedAt: T0 + 5_000 },
    m3: { state: 'delivered' },
    m4: { state: 'surfaced', surfacedAt: T0 - 600_000 }   // surfaced long before: not back
  });
  x.w.noteCompact('god', 'C:/t.jsonl');
  x.w.noteCarry('god', { cardsDoing: ['READS-MAIL-CAP', 'READS-COMPACT-HEALTH'], cardsCarried: ['READS-MAIL-CAP', 'READS-COMPACT-HEALTH'], obligationsOpen: 2, obligationsCarried: 2, mailOpen: ['m1', 'm2', 'm3', 'm4'], mailReinjected: ['m1', 'm2'] });
  x.w.onStop('god');
  const r = x.rows.find((q) => q.kind === 'compact-health');
  assert.equal(r.carry, true);
  assert.equal(r.mailOpen, 4);
  assert.equal(r.mailReinjected, 2);
  assert.equal(r.mailBack, 2);
  assert.deepEqual(r.mailPending, ['m3']);
  assert.deepEqual(r.mailMissing, ['m4']);
  assert.deepEqual(r.cardsNotInSummary, ['READS-COMPACT-HEALTH']);
  assert.deepEqual(r.cardsLost, [], 'carried, so not lost');
  assert.equal(r.ok, false, 'm4 is missing');
  assert.equal(r.n, 1);
  assert.equal(r.summaryChars, 38);
  assert.equal(r.summaryTokensEst, Math.round(38 / 2.5));
  assert.equal(r.idleBeforeMs, 7_200_000);
  assert.equal(r.cacheRewrite, true, 'two hours idle: the cache had expired');
  assert.equal(r.compactCostEst, 300000, 'preTokens x 2');
});

test('watch: ok when everything came back; a card neither carried nor in the summary is lost; owed mail not carried is not ok', () => {
  const tail = [req(iso(T0 - 60_000)), boundary('b1', 150000, iso(T0)), summary('nothing'), req(iso(T0 + 30_000))].join('\n');
  const good = watch(tail, { m1: { state: 'surfacing', surfacingAt: T0 } });
  good.w.noteCompact('god', 'C:/t.jsonl');
  good.w.noteCarry('god', { cardsDoing: ['C1'], cardsCarried: ['C1'], obligationsOpen: 1, obligationsCarried: 1, mailOpen: ['m1'], mailReinjected: ['m1'] });
  good.w.onStop('god');
  const g = good.rows.find((q) => q.kind === 'compact-health');
  assert.equal(g.ok, true);
  assert.equal(g.cacheRewrite, false);
  assert.equal(g.compactCostEst, 15000, 'preTokens x 0.1: a cache read');
  const lost = watch(tail);
  lost.w.noteCompact('god', 'C:/t.jsonl');
  lost.w.noteCarry('god', { cardsDoing: ['C1'], cardsCarried: [], obligationsOpen: 2, obligationsCarried: 1, mailOpen: [], mailReinjected: [] });
  lost.w.onStop('god');
  const l = lost.rows.find((q) => q.kind === 'compact-health');
  assert.deepEqual(l.cardsLost, ['C1']);
  assert.equal(l.ok, false);
  // Creed n1 (god dcea92): a long backlog overflows the note ("- and N more"); that remainder stays in
  // the ledger and the reminders, so it is counted (carryTruncated) and does not fail ok.
  const backlog = Array.from({ length: 30 }, (_, i) => ({ id: `o-${i}`, from: 'jim', subject: 'x'.repeat(100), what: 'request' }));
  const note = CH.compactCarryText([], backlog);
  assert.ok(note.obligations.length < 30 && /- and \d+ more/.test(note.text));
  const owed = watch(tail);
  owed.w.noteCompact('god', 'C:/t.jsonl');
  owed.w.noteCarry('god', { cardsDoing: [], cardsCarried: [], obligationsOpen: 30, obligationsCarried: note.obligations.length, mailOpen: [], mailReinjected: [] });
  owed.w.onStop('god');
  const o = owed.rows.find((q) => q.kind === 'compact-health');
  assert.equal(o.ok, true, 'the truncated remainder is not a loss');
  assert.equal(o.carryTruncated, 30 - note.obligations.length);
  assert.ok(o.carryTruncated > 0);
});

test('watch: two compactions in one turn pair with their carries from the end; n counts both', () => {
  const tail = [boundary('b1', 150000, iso(T0)), req(iso(T0 + 1_000)), boundary('b2', 150000, iso(T0 + 2_000)), req(iso(T0 + 3_000))].join('\n');
  const x = watch(tail);
  x.w.noteCompact('god', 'C:/t.jsonl');
  x.w.noteCarry('god', { cardsDoing: ['A'], cardsCarried: ['A'], obligationsOpen: 0, obligationsCarried: 0, mailOpen: [], mailReinjected: [] });
  x.w.noteCompact('god', 'C:/t.jsonl');
  x.w.noteCarry('god', { cardsDoing: ['B'], cardsCarried: ['B'], obligationsOpen: 0, obligationsCarried: 0, mailOpen: [], mailReinjected: [] });
  x.w.onStop('god');
  const rows = x.rows.filter((q) => q.kind === 'compact-health');
  assert.deepEqual(rows.map((r) => r.n), [1, 2]);
  assert.deepEqual(rows.map((r) => r.cardsDoing), [['A'], ['B']]);
});

test('watch: no carry recorded (a non-inject agent): carry false, ok null, the rest as before', () => {
  const x = watch(TAIL);
  x.w.noteCompact('god', 'C:/t.jsonl');
  x.w.onStop('god');
  const r = x.rows.find((q) => q.kind === 'compact-health');
  assert.equal(r.carry, false);
  assert.equal(r.ok, null);
  assert.equal(r.mailOpen, undefined);
});

test('re-reads: files read before the compaction and read again in the next 3 turns, and inbox reads, in one compact-rereads row', () => {
  const x = watch(TAIL);
  x.w.noteRead('god', 'C:\\Repo\\A.ts');
  x.w.noteRead('god', 'C:\\repo\\b.ts');
  x.w.noteCompact('god', 'C:/t.jsonl');
  x.w.noteRead('god', 'c:/repo/a.ts');                                   // a re-read (case and slashes ignored)
  x.w.noteRead('god', 'C:\\repo\\new.ts');                               // a first read
  x.w.noteRead('god', 'C:\\hive\\agents\\god\\inbox\\m1.json', true);   // the rest of a shortened message
  x.w.onStop('god');
  x.w.noteRead('god', 'C:\\repo\\b.ts');                                 // re-read in turn 2
  x.w.onStop('god');
  assert.equal(x.rows.filter((q) => q.kind === 'compact-rereads').length, 0, 'the window is still open');
  x.w.onStop('god');
  const r = x.rows.find((q) => q.kind === 'compact-rereads');
  assert.deepEqual({ ...r }, { kind: 'compact-rereads', agentId: 'god', compactAt: iso(T0), turns: 3, reads: 4, rereads: 2, inboxReads: 1 });
  x.w.noteRead('god', 'C:\\repo\\a.ts');
  x.w.onStop('god');
  assert.equal(x.rows.filter((q) => q.kind === 'compact-rereads').length, 1, 'counted once, then closed');
});

test('re-reads: a new compaction closes the open window early; a window with no reads logs nothing', () => {
  const x = watch(null);
  x.w.noteCompact('god', null);
  x.w.noteRead('god', 'C:\\repo\\a.ts');
  x.w.noteCompact('god', null);
  const rows = x.rows.filter((q) => q.kind === 'compact-rereads');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].turns, 0);
  assert.equal(rows[0].reads, 1);
  x.w.onStop('god'); x.w.onStop('god'); x.w.onStop('god');
  assert.equal(x.rows.filter((q) => q.kind === 'compact-rereads').length, 1, 'the empty second window is not logged');
});

// ————————————————————————————————————————————————————————————— hooks (real hive, jailed)

async function floor(t) {
  const home = fs.mkdtempSync(path.join(JAIL, 'floor-'));
  const hive = new HiveManager(() => home, () => true);
  const server = { current: null };
  t.after(() => { try { server.current?.stop(); } catch { /* noop */ } hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  const control = { takeSteer: () => null, shouldHalt: () => false, toolDecision: () => ({ deny: false }) };
  const s = new HookServer(hive, () => null, () => ({ notifications: false }), control, undefined, undefined, () => {});
  server.current = s;
  const rows = [];
  const transcript = path.join(home, 't.jsonl');
  s.setCompactHealth(new CH.CompactHealthWatch({
    log: (r) => rows.push(r), windowOf: () => 150000,
    mailStateOf: (agentId, id) => hive.mail?.ledger(agentId).entries[id] ?? null
  }));
  const fire = (agent_id, hook_event_name, extra = {}) => s.handle({ agent_id, hook_event_name, session_id: `s-${agent_id}`, transcript_path: transcript, ...extra });
  const ctx = (res) => res?.hookSpecificOutput?.additionalContext ?? '';
  return { hive, server: s, fire, ctx, rows, transcript };
}

test('hooks: SessionStart(compact) carries the cards in progress and owed mail back, re-injects the open mail, and the Stop row says it came back', async (t) => {
  const f = await floor(t);
  f.hive.writeTasks([
    { id: 'READS-COMPACT-HEALTH', title: 'After each compaction, check', status: 'doing', assignee: 'god-1' },
    { id: 'OTHER', title: 'not mine', status: 'doing', assignee: 'jim-1' },
    { id: 'DONE-ONE', title: 'done', status: 'done', assignee: 'god-1' }
  ]);
  // An answer owed from an earlier turn (the ledger's obligation list).
  f.server.mailReminders = () => [{ entry: { id: 'old-1', from: 'jim-1', act: 'request', subject: 'please check', state: 'acted', epoch: 'e-old' }, ageMs: 3_600_000 }];
  const m = f.hive.send({ to: 'god-1', act: 'inform', subject: 'live', body: 'live body' }, 'jim-1');
  f.fire('god-1', 'UserPromptSubmit', { prompt: 'go' });
  const c = f.ctx(f.fire('god-1', 'SessionStart', { source: 'compact' }));
  assert.ok(c.includes('<after-compaction>'), c.slice(0, 300));
  assert.ok(c.includes('- card READS-COMPACT-HEALTH: "After each compaction, check" (in progress)'));
  assert.ok(!c.includes('OTHER') && !c.includes('DONE-ONE'), 'only this agent\'s doing cards');
  assert.ok(c.includes('- [old-1] from jim-1: "please check" (request)'));
  assert.ok(c.includes(`[hive-mail:${m.id}]`), 'the open mail is re-injected');
  assert.ok(c.indexOf('<after-compaction>') < c.indexOf('<hive-mail>'), 'the carry note first');
  fs.writeFileSync(f.transcript, [req(iso(Date.now() - 10_000)), boundary('b1', 150000, iso(Date.now())), summary('READS-COMPACT-HEALTH in progress'), req(iso(Date.now() + 1_000))].join('\n'));
  f.fire('god-1', 'Stop');
  const r = f.rows.find((q) => q.kind === 'compact-health');
  assert.ok(r, JSON.stringify(f.rows));
  assert.equal(r.carry, true);
  assert.deepEqual(r.cardsDoing, ['READS-COMPACT-HEALTH']);
  assert.equal(r.cardsCarried, 1);
  assert.deepEqual(r.cardsNotInSummary, []);
  assert.equal(r.obligationsOpen, 1);
  assert.equal(r.obligationsCarried, 1);
  assert.equal(r.mailOpen, 1);
  assert.equal(r.mailReinjected, 1);
  // No transcript evidence in this harness, so the Stop that closes the epoch re-pends the
  // unconfirmed re-injection (back to delivered: it drips in again). That is pending, not missing.
  assert.equal(r.mailBack + r.mailPending.length, 1, JSON.stringify(r));
  assert.deepEqual(r.mailMissing, []);
  assert.equal(r.ok, true);
});

test('hooks: a compaction with nothing in progress adds no carry note; a Read after it is counted', async (t) => {
  const f = await floor(t);
  f.server.mailReminders = () => [];
  f.fire('god-1', 'UserPromptSubmit', { prompt: 'go' });
  f.fire('god-1', 'PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'C:\\repo\\a.ts' }, tool_response: {} });
  const c = f.ctx(f.fire('god-1', 'SessionStart', { source: 'compact' }));
  assert.ok(!c.includes('<after-compaction>'));
  f.fire('god-1', 'PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'C:\\repo\\a.ts' }, tool_response: {} });
  f.fire('god-1', 'Stop'); f.fire('god-1', 'Stop'); f.fire('god-1', 'Stop');
  const r = f.rows.find((q) => q.kind === 'compact-rereads');
  assert.ok(r, JSON.stringify(f.rows));
  assert.equal(r.rereads, 1);
});
