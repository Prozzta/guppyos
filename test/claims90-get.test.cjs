'use strict';
/**
 * CLAIMS-90 R2 (C90-GET): `memory get <key|card>` resolves one term to one key set and returns the CURRENT value as
 * a field (Jim ff7793 design, df789a + ac6f85 changes, god 7c1acc mail history, Creed 5f3e80 key contract):
 *  - resolution: exact key, then card.<term>, then the registry alias chain, reconcile key-alias pairs and key-alias
 *    events (union-find); a claim id resolves to its key; a card key covers its derived sub-keys;
 *  - current = newest live claim (--agent: that agent's claim, or the derived row naming its done mail, first);
 *    competing = the other live values; superseded = the inverse of supersedes with a <=120-char excerpt;
 *  - a card's decision list is complete and newest first, never folded into competing;
 *  - the mail rule (Jim 784b65 s4 d): a NEWER card mail naming a known value (or, for donesha/the bare card,
 *    a commit sha in that agent's done mail) is current, with its source; Human mail (no body) never; --no-mail
 *    is the claims-only control; times compare as epoch ms (tie -> claim; dashed mail-id times parse);
 *  - mails newest first, MAIL_DEFAULT per page, --before pages back, one row per mail id;
 *  - an unknown term is exit 0 with the one "no claim under <keys tried>" line, identical on every path;
 *  - read-only: the offline oracle test/tools/claims90-get.cjs prints the same text and JSON and writes nothing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const REPO = path.resolve(__dirname, '..');
const G = loadTs('src/main/claims/get.ts');
const { DEFAULT_KEY_REGISTRY } = loadTs('src/main/claims/registry.ts');

const SHA_A = '1234abc' + 'd'.repeat(33);
const SHA_B = '9876fed' + 'e'.repeat(33);
const c = (id, agent, key, at, text, extra = {}) => ({ t: 'claim', id, at, wt: at, agent, kind: 'fact', key, text, source: 'note', ...extra });
const mail = (id, from, to, act, subject, created_at, body, extra = {}) => JSON.stringify({ v: 1, id, card: 'FOO-7', cards: ['FOO-7'], cardFrom: 'field', from, to, act, subject, created_at, deliveredAt: 1, bodyHash: 'h', trust: 'delivery', ...(body === undefined ? {} : { body }), ...extra });

function registry(aliases = {}) {
  const reg = JSON.parse(JSON.stringify(DEFAULT_KEY_REGISTRY));
  reg.keys = reg.keys || {};
  for (const [k, v] of Object.entries(aliases)) reg.keys[k] = { aliasOf: v };
  return reg;
}

function fixture() {
  const ledgers = {
    derived: [
      c('c-aaaaaaaaaaa1', 'derived', 'card.foo-7.donesha', '2026-10-01T10:00:00.000Z', `Card FOO-7: the newest done mail from alpha-1 (m1) names commit 1234abc (${SHA_A})`, { refs: [{ type: 'commit', value: SHA_A }] }),
      c('c-aaaaaaaaaaa2', 'derived', 'card.foo-7.donesha', '2026-10-02T10:00:00.000Z', `Card FOO-7: the newest done mail from beta-2 (m2) names commit 9876fed (${SHA_B})`, { refs: [{ type: 'commit', value: SHA_B }] }),
      c('c-aaaaaaaaaaa3', 'derived', 'card.foo-7.decision.abcd1234', '2026-10-02T11:00:00.000Z', 'Human decision on FOO-7: asked "x"; the Human answered "yes"', { kind: 'decision' }),
      c('c-aaaaaaaaaaa4', 'derived', 'card.foo-7.decision.abcd5678', '2026-10-01T11:00:00.000Z', 'Human decision on FOO-7: asked "y"; the Human answered "no"', { kind: 'decision' }),
      c('c-aaaaaaaaaaa6', 'derived', 'card.foo-7.decision.abcd9999', '2026-09-01T11:00:00.000Z', 'Human decision on FOO-7: asked "z"; the Human answered "later"', { kind: 'decision' }),
      c('c-aaaaaaaaaaa5', 'derived', 'card.foo-7.status', '2026-10-02T12:00:00.000Z', 'Card FOO-7 status: doing'),
    ],
    'alpha-1': [
      c('c-bbbbbbbbbbb1', 'alpha-1', 'card.foo-7', '2026-09-30T10:00:00.000Z', `FOO-7 build is at 1111111 on branch x ${'long '.repeat(40)}tail`),
      c('c-bbbbbbbbbbb2', 'alpha-1', 'card.foo-7', '2026-10-03T10:00:00.000Z', 'FOO-7 build moved to 2222222 on branch x', { supersedes: ['c-bbbbbbbbbbb1'], supersedesReason: { category: 'changed' } }),
    ],
    'beta-2': [
      c('c-ccccccccccc1', 'beta-2', 'card.foo-7', '2026-10-01T09:00:00.000Z', 'FOO-7: beta thinks the build is 1111111 still'),
      c('c-ccccccccccc2', 'beta-2', 'card.foo-7.donesha', '2026-10-01T12:00:00.000Z', `beta-2 landed FOO-7 as ${SHA_B}`),
    ],
  };
  const tasks = [{ id: 'FOO-7', status: 'doing', assignee: 'alpha-1', title: 'Foo seven', tags: ['x'] }, { id: 'cut-1.1.100', status: 'done', title: 'Dotted' }];
  return { ledgers, tasks };
}

const deps = (over = {}) => { const f = fixture(); return { ledgers: f.ledgers, registry: registry(), reconcileItems: [], tasks: f.tasks, mailRows: () => null, ruleConfig: { r4: false }, ...over }; };
const get = (term, opts = {}, d = deps()) => G.resolveGet(term, opts, d);
const text = (term, opts = {}, d = deps()) => G.formatGet(G.resolveGet(term, opts, d), opts);
const lines = (t) => t.replace(/\n$/, '').split('\n');

test('resolution: exact key; a bare card id (any case, quoted, "memory get" prefix) is card.<id> and covers every derived sub-key; a claim id resolves to its key', () => {
  assert.deepEqual(get('card.foo-7.status').keys, ['card.foo-7.status']);
  for (const term of ['FOO-7', 'foo-7', '"foo-7"', 'memory get foo-7', ' card.foo-7 ']) {
    const r = get(term);
    assert.equal(r.card, 'foo-7', term);
    assert.deepEqual(r.keys, ['card.foo-7', 'card.foo-7.decision.abcd1234', 'card.foo-7.decision.abcd5678', 'card.foo-7.decision.abcd9999', 'card.foo-7.donesha', 'card.foo-7.status'], term);
  }
  const byId = get('c-bbbbbbbbbbb1');
  assert.equal(byId.current.claimId, 'c-bbbbbbbbbbb2', 'a claim id names its key, and the key answers with its current value');
  assert.match(text('FOO-7'), /^get foo-7 → keys: card\.foo-7, card\.foo-7\.decision\.abcd1234.* \(card foo-7\)\n/);
  // A card known only to tasks.json (no claim yet) still resolves (its fields and mails show).
  const r = get('cut-1.1.100');
  assert.equal(r.card, 'cut-1.1.100'); assert.deepEqual(r.keys, ['card.cut-1.1.100']); assert.equal(r.current, null);
  assert.match(text('cut-1.1.100'), /current: none \(no live claim under card\.cut-1\.1\.100\)/);
});

test('alias closure: the registry aliasOf chain, a reconcile key-alias pair and a key-alias event each join keys into one set; the merged keys are printed', () => {
  const d = deps({ registry: registry({ 'card.foo-7.lastsha': 'card.foo-7.donesha' }) });
  const r = get('card.foo-7.lastsha', {}, d);
  assert.deepEqual(r.keys, ['card.foo-7.donesha', 'card.foo-7.lastsha']);
  assert.equal(r.current.claimId, 'c-aaaaaaaaaaa2', 'the newest live donesha row');
  // A reconcile queue pair over two claim ids with different keys.
  const d2 = deps();
  d2.ledgers['gamma-3'] = [c('c-ddddddddddd1', 'gamma-3', 'build.foo7', '2026-10-04T10:00:00.000Z', 'build foo7 at 4444444')];
  d2.reconcileItems = [{ itemId: 'i1', kind: 'key-alias', a: 'c-ddddddddddd1', b: 'c-bbbbbbbbbbb2', text: 'Possible key alias' }];
  const r2 = get('build.foo7', {}, d2);
  assert.ok(r2.keys.includes('card.foo-7') && r2.keys.includes('build.foo7'), r2.keys.join());
  assert.equal(r2.current.claimId, 'c-ddddddddddd1', 'newest across the merged set');
  assert.match(text('build.foo7', {}, d2), /^get build\.foo7 → keys: build\.foo7, card\.foo-7(, card\.foo-7\.[a-z0-9.]+)+(, … \+\d+ more)? \(card foo-7\)\n/);
  // The same pair answered as a key-alias event.
  const d3 = deps();
  d3.ledgers['gamma-3'] = [c('c-ddddddddddd1', 'gamma-3', 'build.foo7', '2026-10-04T10:00:00.000Z', 'build foo7 at 4444444'), { t: 'event', id: 'e-1', at: '2026-10-04T11:00:00.000Z', wt: 'x', agent: 'gamma-3', ev: 'key-alias', targets: ['c-ddddddddddd1', 'c-bbbbbbbbbbb2'] }];
  assert.ok(get('build.foo7', {}, d3).keys.includes('card.foo-7'));
});

test('current, competing, superseded: newest live claim is current; other live values compete; superseded rows carry the inverse of supersedes, the reason and a <=120-char excerpt (MUTANT: ids only)', () => {
  const r = get('card.foo-7');
  assert.equal(r.current.source, 'claim');
  assert.equal(r.current.claimId, 'c-bbbbbbbbbbb2', 'the newest live row under the set (the hand claim, 2026-10-03T10)');
  assert.ok(!r.competing.some((x) => x.claimId === 'c-aaaaaaaaaaa5'), 'MUST 1: a sub-key field row never competes for the bare key');
  assert.ok(r.competing.some((x) => x.claimId === 'c-ccccccccccc1'), 'the other live hand claim competes');
  assert.ok(!r.competing.some((x) => x.kind === 'decision'), 'decisions never compete');
  const s = r.superseded.find((x) => x.claimId === 'c-bbbbbbbbbbb1');
  assert.ok(s, 'the superseded hand claim is listed');
  assert.deepEqual(s.supersededBy, ['c-bbbbbbbbbbb2']);
  assert.equal(s.reason, 'changed');
  assert.ok(s.excerpt.length <= 120 && s.excerpt.endsWith('…') && s.excerpt.includes('1111111'), s.excerpt);
  const t = text('card.foo-7', { history: true });
  assert.match(t, /^superseded \(1\):\n  card\.foo-7: FOO-7 build is at 1111111 .*\[superseded · alpha-1 · 2026-09-30 · c-bbbbbbbbbbb1 → replaced by c-bbbbbbbbbbb2 · changed\]$/m);
  assert.match(t, /^current: card\.foo-7: FOO-7 build moved to 2222222 on branch x\n  \[claim · alpha-1 · 2026-10-03 · c-bbbbbbbbbbb2\]$/m);
});

test('decisions: a card returns its FULL decision list newest first (D1 has 20 rows), a sub-key only its own; fields come from tasks.json', () => {
  const r = get('FOO-7');
  assert.deepEqual(r.decisions.map((x) => x.claimId), ['c-aaaaaaaaaaa3', 'c-aaaaaaaaaaa4', 'c-aaaaaaaaaaa6'], 'all three, newest first (MUTANT: newest only)');
  assert.deepEqual(r.fields, { id: 'FOO-7', status: 'doing', assignee: 'alpha-1', title: 'Foo seven' }, 'primitive fields only');
  // Step 3 fix R1 (god bbcb4a): the list is the --all view; the default view carries the count in the lead block.
  const t = text('FOO-7', { history: true });
  assert.match(t, /^decisions \(3\):\n  card\.foo-7\.decision\.abcd1234: .*\n  card\.foo-7\.decision\.abcd5678: .*\n  card\.foo-7\.decision\.abcd9999: .*\nfields: status=doing assignee=alpha-1 title=Foo seven$/m);
  assert.match(text('FOO-7'), /^decisions: 3 \(--all lists them\)$/m, 'default: the count only');
  assert.doesNotMatch(text('FOO-7'), /^decisions \(3\):/m);
  assert.equal(get('card.foo-7.status').decisions.length, 0, 'a field sub-key is not the card');
  assert.doesNotMatch(text('card.foo-7.status'), /^decisions/m);
});

test('--agent: picks that agent\'s newest live claim, else the derived row naming its done mail ("from <agent> "), else the global newest (Jim df789a a; MUTANT: global only)', () => {
  assert.equal(get('card.foo-7.donesha').current.claimId, 'c-aaaaaaaaaaa2', 'no --agent: newest live');
  assert.equal(get('card.foo-7.donesha', { agent: 'beta-2' }).current.claimId, 'c-ccccccccccc2', 'beta-2 wrote one itself');
  assert.equal(get('card.foo-7.donesha', { agent: 'alpha-1' }).current.claimId, 'c-aaaaaaaaaaa1', 'alpha-1: the derived row "from alpha-1 "');
  assert.equal(get('card.foo-7.donesha', { agent: 'nobody' }).current.claimId, 'c-aaaaaaaaaaa2', 'unknown agent: global newest');
  const t = text('card.foo-7.donesha', { agent: 'alpha-1' });
  assert.match(t, /^get card\.foo-7\.donesha → keys: card\.foo-7\.donesha \(card foo-7\) \[--agent alpha-1\]\n/);
  assert.match(t, /^competing: 2 other live values hidden \(--all lists them\)$/m);
  assert.match(text('card.foo-7.donesha', { agent: 'alpha-1', history: true }), /^competing \(2\):/m);
});

test('mail rule: a NEWER card mail naming a known value is current (source mail, its id named); unknown values, Human mail (no body) and older mail never; --no-mail is the claims-only control', () => {
  const rows = [
    mail('2026-10-04T09-00-00-000Z-aaaaaa', 'alpha-1', 'god', 'inform', 'FOO-7 state', '2026-10-04T09:00:00.000Z', 'the build is back at 1111111 after the revert'),
    mail('2026-10-04T09-00-00-000Z-aaaaaa', 'alpha-1', 'jim-x', 'inform', 'FOO-7 state', '2026-10-04T09:00:00.000Z', 'the build is back at 1111111 after the revert'),
    mail('2026-10-05T09-00-00-000Z-bbbbbb', 'god', 'alpha-1', 'inform', 'FOO-7 chatter', '2026-10-05T09:00:00.000Z', 'no value here at all'),
    mail('2026-10-06T09-00-00-000Z-cccccc', 'human', 'alpha-1', 'inform', 'FOO-7: use 7777777', '2026-10-06T09:00:00.000Z', undefined),
    mail('2026-09-01T09-00-00-000Z-dddddd', 'alpha-1', 'god', 'inform', 'FOO-7 old', '2026-09-01T09:00:00.000Z', 'the build was 2222222 once'),
  ];
  const d = deps({ mailRows: (card) => (card === 'foo-7' ? rows : null) });
  const r = get('card.foo-7', {}, d);
  assert.equal(r.current.source, 'mail');
  assert.equal(r.current.mailId, '2026-10-04T09-00-00-000Z-aaaaaa', 'the newest mail naming a KNOWN value (1111111 is a superseded value); the Human mail has no body, the chatter no value');
  assert.equal(r.current.agent, 'alpha-1');
  assert.ok(r.current.text.includes('1111111'), r.current.text);
  assert.match(G.formatGet(r), /^current: card\.foo-7: FOO-7 state — the build is back at 1111111 after the revert\n  \[mail · alpha-1 · 2026-10-04 · 2026-10-04T09-00-00-000Z-aaaaaa\]$/m);
  const control = get('card.foo-7', { noMail: true }, d);
  assert.equal(control.current.source, 'claim'); assert.equal(control.current.claimId, 'c-bbbbbbbbbbb2');
  // Mail naming only an unknown value: the claim pick stays.
  const d2 = deps({ mailRows: () => [mail('2026-10-07T09-00-00-000Z-eeeeee', 'alpha-1', 'god', 'inform', 'FOO-7', '2026-10-07T09:00:00.000Z', 'maybe 5555555 someday')] });
  assert.equal(get('card.foo-7', {}, d2).current.source, 'claim', 'MUTANT: any newer mail wins');
  // --agent applies to mail too: another agent's mail is not that agent's value.
  assert.equal(get('card.foo-7', { agent: 'beta-2' }, d).current.source, 'claim');
  assert.equal(get('card.foo-7', { agent: 'alpha-1' }, d).current.source, 'mail');
});

test('mail rule, done-sha (Jim ac6f85, G1 6f7b2c): for donesha or the bare card, a commit sha in that agent\'s DONE mail is a known value even with no claim under the key; other fields keep the known-value rule', () => {
  const rows = [mail('2026-10-08T09-00-00-000Z-ffffff', 'alpha-1', 'god', 'done', 'FOO-7 done', '2026-10-08T09:00:00.000Z', `landed as ${'abc1234' + 'f'.repeat(33)} on guppy/foo-7`)];
  const d = deps({ mailRows: () => rows });
  const r = get('card.foo-7.donesha', { agent: 'alpha-1' }, d);
  assert.equal(r.current.source, 'mail'); assert.ok(r.current.text.includes('abc1234'), r.current.text);
  assert.equal(get('card.foo-7.donesha', {}, d).current.source, 'mail', 'without --agent any agent\'s done mail counts');
  assert.equal(get('card.foo-7.donesha', { agent: 'beta-2' }, d).current.source, 'claim', 'not that agent\'s mail');
  assert.equal(get('card.foo-7.status', {}, d).current.source, 'claim', 'status is not a sha field: an unknown sha is not a value');
  // G1 (god 6f7b2c, Jim 3a543d): lastsha/status/assignee/fixVersion are the card record's; no mail becomes their current
  // even when it names their value (MUTANT: lastsha takes the newer done mail).
  const dl = deps({ mailRows: () => rows }); dl.ledgers = { ...dl.ledgers, 'beta-2': [...dl.ledgers['beta-2'], c('c-eeeeeeeeeee1', 'beta-2', 'card.foo-7.lastsha', '2026-10-01T10:00:00.000Z', 'Card FOO-7 lastsha: abc1234f')] };
  assert.equal(get('card.foo-7.lastsha', {}, dl).current.claimId, 'c-eeeeeeeeeee1', 'lastsha: the card record is the authority');
  assert.equal(get('card.foo-7.lastsha', { agent: 'alpha-1' }, dl).current.source, 'claim');
  assert.equal(get('card.foo-7.status', { agent: 'alpha-1' }, dl).current.source, 'claim');
  // donesha takes act=done mails only (MUTANT: a conversation-linked inform naming the sha wins).
  const infRows = [mail('2026-10-09T09-00-00-000Z-eeeeee', 'alpha-1', 'god', 'inform', 'FOO-7 progress', '2026-10-09T09:00:00.000Z', `now at ${SHA_B} too`, { cardFrom: 'conversation' })];
  const di = deps({ mailRows: () => [...infRows, ...rows] });
  const ri = get('card.foo-7.donesha', {}, di);
  assert.equal(ri.current.source, 'mail'); assert.equal(ri.current.mailId, '2026-10-08T09-00-00-000Z-ffffff', 'the done mail, not the newer inform');
  assert.equal(get('card.foo-7', {}, di).current.mailId, '2026-10-09T09-00-00-000Z-eeeeee', 'the bare card still takes any trusted mail naming a known value, whatever its act');
  // F5 shape: a pruned card with NO claim at all under the key still answers from its done mail.
  const d5 = deps({ mailRows: () => rows }); d5.ledgers = { 'alpha-1': [c('c-bbbbbbbbbbb9', 'alpha-1', 'card.foo-7.status', '2026-10-01T10:00:00.000Z', 'Card FOO-7 status: doing')] };
  const r5 = get('card.foo-7.donesha', {}, d5);
  assert.deepEqual(r5.keys, ['card.foo-7.donesha']); assert.equal(r5.current.source, 'mail');
  const tdone = G.formatGet(r5);
  assert.match(tdone, /^current: card\.foo-7\.donesha: FOO-7 done — landed as abc1234f+ on guppy\/foo-7\n  \[mail · alpha-1 · 2026-10-08 · 2026-10-08T09-00-00-000Z-ffffff\]$/m);
  const inform = deps({ mailRows: () => [mail('2026-10-08T09-00-00-000Z-ffffff', 'alpha-1', 'god', 'inform', 'FOO-7 wip', '2026-10-08T09:00:00.000Z', `trying ${'abc1234' + 'f'.repeat(33)}`)] });
  assert.equal(get('card.foo-7.donesha', {}, inform).current.source, 'claim', 'an inform mail is not a done mail');
});

test('time compare is epoch ms, never strings: a tie goes to the claim; a dashed mail-id time (no created_at) parses; an ISO string that would sort "later" as text but is earlier loses (census row)', () => {
  const claimAt = '2026-10-03T10:00:00.000Z';
  const pickCurrent = (created_at, id) => get('card.foo-7', {}, deps({ mailRows: () => [mail(id, 'alpha-1', 'god', 'inform', 'FOO-7', created_at, 'back at 1111111', created_at === undefined ? {} : { created_at })] })).current.source;
  // The newest live claim under card.foo-7 is the hand claim c-bbbbbbbbbbb2 at 2026-10-03T10:00Z: compare against that pick.
  const pickMs = Date.parse('2026-10-03T10:00:00.000Z');
  assert.equal(pickCurrent(new Date(pickMs).toISOString(), '2026-10-03T10-00-00-000Z-tie000'), 'claim', 'tie: the claim');
  assert.equal(pickCurrent(new Date(pickMs + 1).toISOString(), '2026-10-03T10-00-00-001Z-ms0001'), 'mail', '1 ms newer: the mail');
  assert.equal(pickCurrent('2026-10-03T12:00:00+02:00', '2026-10-03T10-00-00-000Z-offset'), 'claim', 'an offset time equal in ms (text sorts later) is a tie');
  assert.equal(pickCurrent('2026-10-03T12:00:00.500+02:00', '2026-10-03T10-00-00-500Z-offset'), 'mail', 'offset form, 500 ms newer');
  assert.equal(pickCurrent(undefined, '2026-10-03T10-00-00-001Z-dashed'), 'mail', 'no created_at: the dashed id time parses (mixed formats)');
  assert.equal(pickCurrent(undefined, '2026-10-03T09-59-59-999Z-dashed'), 'claim');
  assert.equal(G.epochMs('2026-10-25T07-14-05-563Z-df789a'), Date.parse('2026-10-25T07:14:05.563Z'));
  assert.equal(G.epochMs('2026-10-25T07-14-05Z-x'), Date.parse('2026-10-25T07:14:05.000Z'));
  assert.ok(Number.isNaN(G.epochMs('yesterday')));
  void claimAt;
});

test('mails: newest first, MAIL_DEFAULT per page, one row per mail id with recipients joined, --before pages back, --mail 0 hides them; an absent index says so', () => {
  const rows = [];
  for (let i = 1; i <= 7; i++) rows.push(mail(`2026-10-1${i}T09-00-00-000Z-m${i}`, 'alpha-1', i === 3 ? 'god' : 'jim-x', 'inform', `FOO-7 mail ${i}`, `2026-10-1${i}T09:00:00.000Z`, 'nothing valued'));
  rows.push(mail('2026-10-13T09-00-00-000Z-m3', 'alpha-1', 'creed-y', 'inform', 'FOO-7 mail 3', '2026-10-13T09:00:00.000Z', 'nothing valued'));
  const d = deps({ mailRows: () => rows });
  const r = get('FOO-7', {}, d);
  assert.equal(r.mailIndex, 'present');
  assert.deepEqual(r.mails.map((m) => m.id.slice(-2)), ['m7', 'm6', 'm5', 'm4', 'm3']);
  assert.equal(r.mails.length, G.MAIL_DEFAULT);
  assert.deepEqual(r.mails[4].to, ['god', 'creed-y'], 'two recipients, one row');
  assert.equal(r.nextBefore, '2026-10-13T09-00-00-000Z-m3');
  const page2 = get('FOO-7', { before: r.nextBefore }, d);
  assert.deepEqual(page2.mails.map((m) => m.id.slice(-2)), ['m2', 'm1']); assert.equal(page2.nextBefore, null);
  assert.equal(get('FOO-7', { mail: 0 }, d).mails.length, 0);
  assert.equal(get('FOO-7', { mail: 500 }, d).mails.length, 7, 'capped at MAIL_MAX, not refused here (the endpoint refuses >50)');
  const t = G.formatGet(r);
  // L5 (god fada64): a mail row is labelled `mail:` (its id before a colon read as a field label to the oracle).
  assert.match(t, /^mails \(5 newest first; older: --before 2026-10-13T09-00-00-000Z-m3\):\n  mail: 2026-10-17T09-00-00-000Z-m7 alpha-1 → jim-x inform — FOO-7 mail 7 \[field · delivery\]\n/m);
  assert.match(t, /^  mail: 2026-10-13T09-00-00-000Z-m3 alpha-1 → god,creed-y inform — FOO-7 mail 3 \[field · delivery\]$/m);
  assert.match(text('FOO-7', {}, deps({ mailRows: () => null })), /^mails: no mail index for this card yet \(hive\/state\/mail-cards\)$/m);
  assert.equal(get('card.foo-7.status', {}, d).mails.length, 5, 'a sub-key is still the card: its mail shows');
});

test('unknown term: exit-0 shape with current null and the ONE "no claim under <keys tried>" line (identical on every path); a card.-prefixed term is tried once', () => {
  const r = get('nothing-here');
  assert.equal(r.current, null); assert.deepEqual(r.keys, []); assert.deepEqual(r.tried, ['nothing-here', 'card.nothing-here']);
  assert.equal(text('nothing-here'), 'no claim under nothing-here, card.nothing-here\n');
  assert.equal(text('card.nothing-here'), 'no claim under card.nothing-here\n');
  assert.equal(text('c-000000000000'), 'no claim under c-000000000000, card.c-000000000000\n', 'an unknown claim id is just a term');
});

test('offline oracle (test/tools/claims90-get.cjs): over a hive FOLDER it prints the same text and JSON as resolveGet/formatGet, exits 0 on an unknown term with the same line, and writes nothing (sha256 of every file unchanged)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c90-get-'));
  const f = fixture();
  for (const [agent, recs] of Object.entries(f.ledgers)) {
    const dir = path.join(root, 'agents', agent, 'memory', 'claims'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2026-10.jsonl'), recs.map((x) => JSON.stringify(x)).join('\n') + '\n');
  }
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({ tasks: f.tasks }));
  fs.writeFileSync(path.join(root, 'claims-reconcile-queue.json'), JSON.stringify({ agents: { 'alpha-1': { sequence: 1, items: [], r5: [] } } }));
  fs.mkdirSync(path.join(root, 'state', 'mail-cards'), { recursive: true });
  const rows = [mail('2026-10-08T09-00-00-000Z-ffffff', 'alpha-1', 'god', 'done', 'FOO-7 done', '2026-10-08T09:00:00.000Z', `landed as ${'abc1234' + 'f'.repeat(33)}`)];
  fs.writeFileSync(path.join(root, 'state', 'mail-cards', 'foo-7.jsonl'), rows.join('\n') + '\n');
  const digest = () => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(`${path.relative(root, p)} ${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`); } }; walk(root); return out.sort().join('\n'); };
  const before = digest();
  const run = (...args) => spawnSync(process.execPath, [path.join(REPO, 'test', 'tools', 'claims90-get.cjs'), root, ...args], { encoding: 'utf8', cwd: REPO, timeout: 120_000 });
  const d = deps({ mailRows: (card) => (card === 'foo-7' ? rows : null) });
  for (const [term, flags, opts] of [['FOO-7', [], {}], ['card.foo-7.donesha', ['--agent', 'alpha-1'], { agent: 'alpha-1' }], ['card.foo-7.donesha', ['--agent', 'beta-2', '--no-mail'], { agent: 'beta-2', noMail: true }], ['c-bbbbbbbbbbb1', ['--mail', '1'], { mail: 1 }]]) {
    const r = run(term, ...flags);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, text(term, opts, d), `text path: ${term} ${flags.join(' ')}`);
    const j = run(term, ...flags, '--json');
    assert.deepEqual(JSON.parse(j.stdout), JSON.parse(JSON.stringify(get(term, opts, d))), `json path: ${term}`);
  }
  const none = run('nothing-here');
  assert.equal(none.status, 0); assert.equal(none.stdout, 'no claim under nothing-here, card.nothing-here\n');
  assert.equal(digest(), before, 'READ-ONLY: no file changed');
  assert.equal(run().status, 2, 'usage');
  fs.rmSync(root, { recursive: true, force: true });
});

test('db7d4a + T5 (god fe1140): a mention-body mail is listed weak and never current; only field/reply/conversation/mention-subject links can; at equal time subject+conversation outranks subject-only', () => {
  const body = mail('2026-10-08T09-00-00-000Z-f00001', 'alpha-1', 'god', 'inform', 'build chatter', '2026-10-08T09:00:00.000Z', 'FOO-7 is back at 1111111', { cardFrom: 'mention-body' });
  const r = get('card.foo-7', {}, deps({ mailRows: () => [body] }));
  assert.equal(r.current.source, 'claim', 'MUTANT: a body-only mention makes a mail current');
  assert.equal(r.mails.length, 1); assert.equal(r.mails[0].weak, true);
  assert.match(G.formatGet(r), /\[mention-body · weak · delivery\]$/m);
  const subj = mail('2026-10-08T09-00-00-000Z-f00002', 'alpha-1', 'god', 'inform', 'FOO-7 is back at 1111111', '2026-10-08T09:00:00.000Z', 'see subject', { cardFrom: 'mention-subject' });
  const r2 = get('card.foo-7', {}, deps({ mailRows: () => [body, subj] }));
  assert.equal(r2.current.source, 'mail'); assert.equal(r2.current.mailId, '2026-10-08T09-00-00-000Z-f00002');
  assert.equal(r2.mails.find((m) => m.id.endsWith('f00002')).weak, false);
  assert.match(G.formatGet(r2), /\[mention-subject · delivery\]$/m);
  // T5: the same epoch ms, two trusted mails naming different known values: the stronger link wins whatever the row order.
  const a = mail('2026-10-09T09-00-00-000Z-f00003', 'alpha-1', 'god', 'inform', 'FOO-7 at 1111111', '2026-10-09T09:00:00.000Z', 'x', { cardFrom: 'mention-subject' });
  const b = mail('2026-10-09T09-00-00-000Z-f00004', 'alpha-1', 'god', 'inform', 'FOO-7 at 2222222', '2026-10-09T09:00:00.000Z', 'y', { cardFrom: 'mention-subject+conversation' });
  assert.equal(get('card.foo-7', {}, deps({ mailRows: () => [a, b] })).current.mailId, '2026-10-09T09-00-00-000Z-f00004', 'MUTANT: no link-strength tiebreak');
  assert.equal(get('card.foo-7', {}, deps({ mailRows: () => [b, a] })).current.mailId, '2026-10-09T09-00-00-000Z-f00004');
  assert.ok(G.linkRank('mention-subject+conversation') > G.linkRank('mention-subject'));
  assert.ok(G.linkRank('field') > G.linkRank('reply+conversation+mention-subject'), 'an explicit card field outranks every inferred link');
  assert.equal(G.linkRank('mention-body'), 0);
  assert.equal(G.trustedLink('mention'), false, 'an unsplit legacy mention is weak until the index splits it');
});

test('R4 merge class (god 4268df): one `merge:` lead line per live merge claim, newest first, `<tip> into <target>` as stored; a value with no target says `into ? (not structured yet)`', () => {
  const f = fixture();
  const T1 = '1'.repeat(40); const T2 = '2'.repeat(40);
  const m1 = c('c-ggggggggggg3', 'derived', 'card.foo-7.merge', '2026-10-20T10:00:00.000Z', `Card FOO-7: branch guppy/foo-7 merged into int-1.1.102 at ${T1}`, { value: `${T1} into int-1.1.102` });
  const m2 = c('c-ggggggggggg4', 'derived', 'card.foo-7.merge', '2026-10-24T10:00:00.000Z', `Card FOO-7: branch guppy/foo-7 merged into int-1.1.103 at ${T2}`, { value: `${T2} into int-1.1.103` });
  const d = deps({ ledgers: { ...f.ledgers, derived: [...f.ledgers.derived, m1, m2] } });
  const mergeLines = (t) => t.split('\n').filter((l) => l.startsWith('merge: '));
  assert.deepEqual(mergeLines(text('FOO-7', {}, d)), [`merge: ${T2} into int-1.1.103`, `merge: ${T1} into int-1.1.102`], 'MUTANT: oldest first, one line only, or the target clipped');
  assert.deepEqual(get('FOO-7', {}, d).lead.filter((l) => l.field === 'merge').map((l) => l.id), ['c-ggggggggggg4', 'c-ggggggggggg3']);
  // god 234b13: an rc merge lives under its own key (card.<id>.merge.rc): it never replaces the INT merge; the lead prints INT first, then rc.
  const T3 = '3'.repeat(40);
  const rc = deps({ ledgers: { ...f.ledgers, derived: [...f.ledgers.derived, m1, m2, c('c-ggggggggggg6', 'derived', 'card.foo-7.merge.rc', '2026-10-25T10:00:00.000Z', `Card FOO-7: branch guppy/foo-7 merged into rc-1.1.104 at ${T3}`, { value: `${T3} into rc-1.1.104` })] } });
  assert.deepEqual(mergeLines(text('FOO-7', {}, rc)), [`merge: ${T2} into int-1.1.103`, `merge: ${T1} into int-1.1.102`, `merge: ${T3} into rc-1.1.104`], 'MUTANT: the newer rc merge above or instead of the INT merges');
  assert.deepEqual(get('FOO-7', {}, rc).lead.filter((l) => l.field === 'merge').map((l) => l.key), ['card.foo-7.merge', 'card.foo-7.merge', 'card.foo-7.merge.rc']);
  assert.deepEqual(G.leadBrief(get('FOO-7', {}, rc)).filter((b) => b.startsWith('merge: ')), [`merge: ${T2} into int-1.1.103`, `merge: ${T1} into int-1.1.102`, `merge: ${T3} into rc-1.1.104`], 'the brief carries both kinds');
  assert.equal(G.cardIdOfKey('card.foo-7.merge.rc'), 'foo-7');
  assert.deepEqual(G.CARD_FIELDS.slice(5, 8), ['merge', 'merge.rc', 'audit']);
  assert.ok(!text('FOO-7', {}, d).includes('merge.rc'), 'no rc merge: no rc line and no `merge.rc` label');
  const mk = get('card.foo-7.merge', {}, rc);
  assert.equal(mk.current.claimId, 'c-ggggggggggg4', 'MUTANT: the newer rc merge read as the current of the INT merge key');
  assert.deepEqual(mk.keys, ['card.foo-7.merge']); assert.deepEqual(mk.competing.map((x) => x.claimId), ['c-ggggggggggg3'], 'the older INT merge competes (R4); the rc merge never does');
  assert.equal(get('card.foo-7.merge.rc', {}, rc).current.claimId, 'c-ggggggggggg6');
  assert.equal(get('guppy/foo-7', {}, rc).current.claimId, 'c-ggggggggggg4', 'ruling 3: the branch term resolves to the INT merge sub-key');
  assert.deepEqual(mergeLines(text('guppy/foo-7', {}, rc)), [`merge: ${T2} into int-1.1.103`, `merge: ${T1} into int-1.1.102`, `merge: ${T3} into rc-1.1.104`], 'the branch reply leads with both kinds, INT first');
  // A branch no card owns: branch.<b> (INT) and branch.<b>.rc stay apart; the current is the INT merge, the reply leads with both.
  const ob = deps({ ledgers: { ...f.ledgers, derived: [...f.ledgers.derived,
    c('c-ggggggggggg7', 'derived', 'branch.hotfix-2', '2026-10-20T10:00:00.000Z', `Branch guppy/hotfix-2 merged into int-1.1.103 at ${T1}`, { value: `${T1} into int-1.1.103` }),
    c('c-ggggggggggg8', 'derived', 'branch.hotfix-2.rc', '2026-10-25T10:00:00.000Z', `Branch guppy/hotfix-2 merged into rc-1.1.104 at ${T3}`, { value: `${T3} into rc-1.1.104` })] } });
  const o = get('guppy/hotfix-2', {}, ob);
  assert.deepEqual(o.keys, ['branch.hotfix-2']); assert.equal(o.current.claimId, 'c-ggggggggggg7', 'MUTANT: the newer rc merge became the branch current'); assert.deepEqual(o.competing, []);
  assert.deepEqual(mergeLines(text('guppy/hotfix-2', {}, ob)), [`merge: ${T1} into int-1.1.103`, `merge: ${T3} into rc-1.1.104`], 'MUTANT: rc first, or the rc merge missing from the branch reply');
  assert.equal(get('branch.hotfix-2.rc', {}, ob).current.claimId, 'c-ggggggggggg8');
  assert.equal(get('guppy/hotfix-2', {}, deps({ ledgers: { ...f.ledgers, derived: [...f.ledgers.derived, c('c-ggggggggggg7', 'derived', 'branch.hotfix-2', '2026-10-20T10:00:00.000Z', 'x', { value: `${T1} into int-1.1.103` })] } })).lead, null, 'no rc merge: the plain branch reply has no lead');
  const bare = deps({ ledgers: { ...f.ledgers, derived: [...f.ledgers.derived, c('c-ggggggggggg5', 'derived', 'card.foo-7.merge', '2026-10-24T10:00:00.000Z', `Card FOO-7: merged at ${T2}`, { value: T2 })] } });
  assert.deepEqual(mergeLines(text('FOO-7', {}, bare)), [`merge: ${T2} into ? (not structured yet)`], 'MUTANT: a tip with no target prints as a whole merge');
  assert.ok(G.leadBrief(get('FOO-7', {}, bare)).includes(`merge: ${T2} into ? (not structured yet)`), 'the brief flags it the same way');
  assert.deepEqual(G.leadBrief(get('FOO-7', {}, d)).filter((b) => b.startsWith('merge: ')), [`merge: ${T2} into int-1.1.103`, `merge: ${T1} into int-1.1.102`], 'S2 (god 7a4eec): the brief carries every merge, newest first');
});

test('ruling 3 (god 690425, Creed bc11fc): a branch name (guppy/<b>, origin/guppy/<b>, any case) resolves to card.<b>.merge when <b> is a card and a merge claim exists, else to card.<b>, else to branch.<b> when claimed; the merge sub-key never becomes the bare card current (MUTANT: branch not resolved / merge claim is the bare current)', () => {
  assert.equal(G.branchName('guppy/FOO-7'), 'foo-7'); assert.equal(G.branchName('origin/guppy/foo-7'), 'foo-7'); assert.equal(G.branchName('guppy/hotfix-1'), 'hotfix-1');
  assert.equal(G.branchName('foo-7'), null, 'no slash: a card id, not a branch'); assert.equal(G.branchName('guppy/a/b'), null, 'a nested name is no valid key');
  assert.equal(G.branchKeyOf('Hotfix-1'), 'branch.hotfix-1');
  const f = fixture();
  const merge = c('c-ggggggggggg1', 'derived', 'card.foo-7.merge', '2026-10-24T10:00:00.000Z', 'Card FOO-7: branch guppy/foo-7 was last merged into INT-1.1.102 at tip 22222222 by merge commit 44444444');
  const orphan = c('c-ggggggggggg2', 'derived', 'branch.hotfix-1', '2026-10-06T10:00:00.000Z', 'Branch guppy/hotfix-1 was last merged into INT-1.1.102 at tip 33333333 by merge commit 55555555');
  const d = deps({ ledgers: { ...f.ledgers, derived: [...f.ledgers.derived, merge, orphan] } });
  const r = get('guppy/FOO-7', {}, d);
  assert.deepEqual(r.keys, ['card.foo-7.merge']); assert.equal(r.card, 'foo-7'); assert.equal(r.current.claimId, 'c-ggggggggggg1', 'MUTANT: the branch did not resolve to the merge claim');
  assert.deepEqual(r.tried, ['guppy/foo-7', 'card.guppy/foo-7', 'card.foo-7.merge', 'branch.foo-7']);
  assert.equal(get('origin/guppy/foo-7', {}, d).current.claimId, 'c-ggggggggggg1');
  assert.equal(get('card.foo-7', {}, d).current.claimId, 'c-bbbbbbbbbbb2', 'MUTANT: the newer merge sub-key claim became the bare card current');
  assert.ok(get('card.foo-7', {}, d).keys.includes('card.foo-7.merge'), 'the merge sub-key is in the card set');
  const o = get('guppy/hotfix-1', {}, d);
  assert.deepEqual(o.keys, ['branch.hotfix-1']); assert.equal(o.card, null); assert.equal(o.current.claimId, 'c-ggggggggggg2');
  assert.match(G.formatGet(o), /^get guppy\/hotfix-1 → keys: branch\.hotfix-1$/m);
  assert.deepEqual(get('guppy/nobody', {}, d).keys, [], 'no card, no claims: unknown');
  // A card with no merge claim yet: the branch is still the card.
  assert.deepEqual(get('guppy/cut-1.1.100', {}, d).keys, ['card.cut-1.1.100']);
  // A pruned card known only by its claims owns its branch too.
  const dp = deps({ tasks: [], ledgers: { derived: [merge] } });
  assert.deepEqual(get('guppy/foo-7', {}, dp).keys, ['card.foo-7.merge']);
});

test('G2 (god 6f7b2c, Jim 3a543d): for release.<v> the derived git-sourced claim is current and newer agent claims compete; --agent still picks that agent (MUTANT: newest wins)', () => {
  const git = c('c-fffffffffff1', 'derived', 'release.1.1.100', '2026-10-20T10:00:00.000Z', 'Guppy 1.1.100, tag v1.1.100 is commit 0123456789abcdef0123456789abcdef01234567', { source: 'derived', refs: [{ type: 'commit', value: '0123456789abcdef0123456789abcdef01234567' }] });
  const note = c('c-fffffffffff2', 'alpha-1', 'release.1.1.100', '2026-10-22T10:00:00.000Z', '1.1.101 cut as 89abcdef0123456789abcdef0123456789abcdef');
  const d = deps({ ledgers: { derived: [git], 'alpha-1': [note] } });
  const r = get('release.1.1.100', {}, d);
  assert.equal(r.current.claimId, 'c-fffffffffff1', 'MUTANT: the newer mis-keyed agent note became current');
  assert.deepEqual(r.competing.map((x) => x.claimId), ['c-fffffffffff2']);
  assert.equal(get('release.1.1.100', { agent: 'alpha-1' }, d).current.claimId, 'c-fffffffffff2');
  assert.equal(get('release.1.1.100', {}, deps({ ledgers: { 'alpha-1': [note] } })).current.claimId, 'c-fffffffffff2', 'no git claim: newest');
});

test('MUST 1 (god 5b990a A, Jim ad1da8): a bare card key takes current/competing/superseded only from claims keyed card.<id> or its aliases; a newer sub-key field claim stays in fields/decisions (MUTANT: newest row under the set)', () => {
  const f = fixture();
  const late = c('c-ddddddddddd1', 'derived', 'card.foo-7.assignee', '2026-10-24T17:53:49.905Z', 'Card FOO-7 assignee: alpha-1');
  const old = c('c-ddddddddddd2', 'derived', 'card.foo-7.status', '2026-09-01T10:00:00.000Z', 'Card FOO-7 status: todo', { supersedes: ['c-ddddddddddd0'] });
  const d = deps({ ledgers: { ...f.ledgers, derived: [...f.ledgers.derived, late, old] } });
  const r = get('card.foo-7', {}, d);
  assert.equal(r.current.claimId, 'c-bbbbbbbbbbb2', 'MUTANT: the backfill-stamped field claim became current');
  assert.ok(r.competing.every((x) => x.key === 'card.foo-7'), r.competing.map((x) => x.key).join());
  assert.ok(r.superseded.every((x) => x.key === 'card.foo-7'), r.superseded.map((x) => x.key).join());
  assert.ok(r.keys.includes('card.foo-7.assignee') && r.fields.assignee === 'alpha-1', 'the sub-key is still in the set and the field shows');
  assert.equal(get('card.foo-7.assignee', {}, d).current.claimId, 'c-ddddddddddd1', 'the sub-key itself still answers');
  assert.equal(get('card.foo-7', { agent: 'alpha-1' }, d).current.claimId, 'c-bbbbbbbbbbb2');
  // An alias of the bare key still counts as its own.
  const d2 = deps({ ledgers: d.ledgers, registry: registry({ 'build.foo7': 'card.foo-7' }) });
  assert.equal(get('build.foo7', {}, d2).current.claimId, 'c-bbbbbbbbbbb2');
});

test('T2 (god fe1140): the text view prints COUNTS of competing/superseded rows and lists their bodies only on --all; the JSON keeps every row; C90_HIDE_STALE=0 is the OFF arm (MUTANT: bodies always)', () => {
  const r = get('card.foo-7');
  assert.ok(r.competing.length >= 1 && r.superseded.length === 1, 'the JSON keeps every row');
  const saved = process.env.C90_HIDE_STALE; delete process.env.C90_HIDE_STALE;
  try {
    const t = G.formatGet(r);
    assert.match(t, /^competing: \d+ other live values? hidden \(--all lists them\)$/m);
    assert.match(t, /^superseded: 1 replaced value hidden \(--all lists them\)$/m);
    // (step 3 fix R1: the lead block cites the live status sub-key claim c-aaaaaaaaaaa5 as its source; that is no body)
    assert.doesNotMatch(t, /c-bbbbbbbbbbb1|1111111/, 'no stale body in the default view');
    assert.match(t, /^current: card\.foo-7: FOO-7 build moved to 2222222 on branch x$/m, 'the current line is unchanged');
    const all = G.formatGet(r, { history: true });
    assert.match(all, /^competing \(\d+\):$/m); assert.match(all, /^superseded \(1\):$/m); assert.match(all, /c-bbbbbbbbbbb1/);
    process.env.C90_HIDE_STALE = '0';
    // Step 3 fix R1: --all also lists the decisions and lifts the cap; the OFF arm only shows the bodies (still in the
    // compact shape, so the long superseded line is clipped at GET_LINE_MAX: pin its body text, not its tail id).
    const off = G.formatGet(r);
    assert.match(off, /^competing \(\d+\):$/m); assert.match(off, /^superseded \(1\):$/m); assert.match(off, /c-ccccccccccc1/, 'the OFF arm prints the competing body');
    assert.match(off, /^  card\.foo-7: FOO-7 build is at 1111111 on branch x/m, 'the OFF arm prints the superseded body');
    assert.match(off, /^decisions: 3 \(--all lists them\)$/m);
    process.env.C90_HIDE_STALE = '1';
    assert.equal(G.formatGet(r), t, 'any other value is ON');
  } finally { if (saved === undefined) delete process.env.C90_HIDE_STALE; else process.env.C90_HIDE_STALE = saved; }
});

// CLAIMS-KEYFIND-FOLLOWUPS (c), god 8ee714: open key-alias pairs over versions / two known cards.
function versionDeps() {
  const ledgers = {
    'alpha-1': [
      c('c-aaaaaaaaaaa1', 'alpha-1', 'card.int-1.1.100', '2026-10-01T10:00:00.000Z', 'INT-1.1.100 merged at 1111111'),
      c('c-aaaaaaaaaaa2', 'alpha-1', 'card.cut-1.1.100', '2026-10-02T10:00:00.000Z', 'CUT-1.1.100 installer at 2222222'),
      c('c-aaaaaaaaaaa3', 'alpha-1', 'card.int-1.1.101', '2026-10-03T10:00:00.000Z', 'INT-1.1.101 merged at 3333333'),
      c('c-aaaaaaaaaaa4', 'alpha-1', 'card.int-1.1.102', '2026-10-04T10:00:00.000Z', 'INT-1.1.102 merged at 4444444'),
      c('c-aaaaaaaaaaa5', 'alpha-1', 'card.foo-7', '2026-10-05T10:00:00.000Z', 'FOO-7 build at 5555555'),
      c('c-aaaaaaaaaaa6', 'alpha-1', 'card.fo-7', '2026-10-06T10:00:00.000Z', 'FO-7 (typo) build at 6666666'),
    ],
  };
  const tasks = [{ id: 'INT-1.1.100', status: 'done' }, { id: 'CUT-1.1.100', status: 'done' }, { id: 'INT-1.1.101', status: 'done' }, { id: 'INT-1.1.102', status: 'doing' }, { id: 'FOO-7', status: 'doing' }];
  // The open proposals the typo-distance census made before the fix (persisted queues still carry them).
  const open = (i, a, b) => ({ itemId: `i${i}`, kind: 'key-alias', a, b, text: 'Possible key alias' });
  const reconcileItems = [open(1, 'c-aaaaaaaaaaa1', 'c-aaaaaaaaaaa2'), open(2, 'c-aaaaaaaaaaa1', 'c-aaaaaaaaaaa3'), open(3, 'c-aaaaaaaaaaa3', 'c-aaaaaaaaaaa4'), open(4, 'c-aaaaaaaaaaa5', 'c-aaaaaaaaaaa6')];
  return { ledgers, registry: JSON.parse(JSON.stringify(DEFAULT_KEY_REGISTRY)), reconcileItems, tasks, mailRows: () => null, ruleConfig: { r4: false } };
}

test('CLAIMS-KEYFIND-FOLLOWUPS (c) get: open key-alias pairs no longer merge card.int-1.1.100 / cut-1.1.100 / int-1.1.101 / int-1.1.102: each version answers with its own fact; a typo pair over one unknown card still merges', () => {
  const d = versionDeps();
  const r102 = G.resolveGet('card.int-1.1.102', {}, d);
  assert.deepEqual(r102.keys, ['card.int-1.1.102'], 'MUTANT: another version\'s key joined the set');
  assert.equal(r102.current.claimId, 'c-aaaaaaaaaaa4');
  const r100 = G.resolveGet('card.int-1.1.100', {}, d);
  assert.deepEqual(r100.keys, ['card.int-1.1.100'], 'two cards tasks.json knows (int / cut) never merge on edit distance');
  assert.equal(r100.current.claimId, 'c-aaaaaaaaaaa1', 'not the cut card\'s newer fact');
  assert.deepEqual(G.resolveGet('card.cut-1.1.100', {}, d).keys, ['card.cut-1.1.100']);
  assert.equal(G.resolveGet('card.int-1.1.101', {}, d).current.claimId, 'c-aaaaaaaaaaa3');
  assert.doesNotMatch(G.formatGet(r102, {}), /1\.1\.100|1\.1\.101/, 'the printed answer names no other version');
  const typo = G.resolveGet('card.foo-7', {}, d);
  assert.deepEqual(typo.keys, ['card.fo-7', 'card.foo-7'], 'fo-7 is no card in tasks.json: the open typo pair still joins');
  assert.equal(typo.current.claimId, 'c-aaaaaaaaaaa6');
});

test('CLAIMS-KEYFIND-FOLLOWUPS (c) get: an ANSWERED alias is the agent\'s word and still joins the same keys (key-alias event; registry aliasOf)', () => {
  const d = versionDeps();
  d.reconcileItems = [];
  d.ledgers['alpha-1'].push({ t: 'event', id: 'e-1', at: '2026-10-07T10:00:00.000Z', wt: 'x', agent: 'alpha-1', ev: 'key-alias', targets: ['c-aaaaaaaaaaa3', 'c-aaaaaaaaaaa4'] });
  const r = G.resolveGet('card.int-1.1.101', {}, d);
  assert.deepEqual(r.keys, ['card.int-1.1.101', 'card.int-1.1.102'], 'an answered key-alias event joins whatever the agent said');
  assert.equal(r.current.claimId, 'c-aaaaaaaaaaa4');
  const d2 = versionDeps();
  d2.reconcileItems = [];
  d2.registry.keys = { ...(d2.registry.keys || {}), 'card.cut-1.1.100': { aliasOf: 'card.int-1.1.100' } };
  assert.deepEqual(G.resolveGet('card.int-1.1.100', {}, d2).keys, ['card.cut-1.1.100', 'card.int-1.1.100'], 'a registry alias joins as before');
});
