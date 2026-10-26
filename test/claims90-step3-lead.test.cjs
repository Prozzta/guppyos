'use strict';
/**
 * CLAIMS-90 step 3 fix (god bbcb4a, after Jim f0d494: agents typed the field term on 6 of 332 rows, the bare card
 * on 142, and 40% of get replies passed the 1500 cap):
 *  R1: a bare card `memory get <CARD-ID>` LEADS with one compact block of per-field current values (donesha, lastsha,
 *      status, assignee, fixVersion, merge, audit, then the decision count); the whole reply is under the 1500 cap by
 *      construction (every line under GET_LINE_MAX, the tail behind a pointer past GET_MAX_CHARS); the decision list
 *      and the competing / superseded bodies are behind --all / --history; guppy/<branch> and release.<v> get the
 *      same shape; a field sub-key the agent typed has no lead.
 *  L2-L5 (god fada64, after Jim a293f7: the lead printed prose windows, 2/84): a lead line is `field: <value>` from the
 *      claim's STRUCTURED value (L1, Creed: ClaimRec.value / valueAgent), never a window on the prose, no title and no
 *      card id on it; a per-agent field (donesha) prints `field (latest): value by agent` then one `field (agent): value`
 *      per agent, newest first (L3); release.<v> leads with tag: and bump:, audit joins the card fields (L4); the lead
 *      block is the only `label:` text in the reply, no claim id sits on a value line, and the ids go on one `sources:`
 *      line (wrapped, never clipped) written so none reads as a sha (L5: c-<12 hex> → c_<12 hex>).
 *  L7 (god 985a82): test/tools/claims90-search.cjs --hive <root> builds the briefs through main's claimCardLeadOver and
 *      the engine's own helpers: its text is byte-for-byte the engine's.
 *  R2: a search hit on a card (any claim keyed card.<id>.*) carries the card's current values inline (`<id> now:
 *      field: value · …`) once per card, inside the hit's budget, never under one content line (the matched term
 *      stays shown); the worker asks main for them over the port (`{ ask, op, args }` → `{ answer, result }`), and
 *      a missing, failing or slow answer prints the hits as before.
 *  Also pinned: the worker's search op passes --exact / --newest to the engine (they were dropped on the way).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const REPO = path.resolve(__dirname, '..');
const G = loadTs('src/main/claims/get.ts');
const F = loadTs('src/main/nativeMemory/format.ts');
const { TOOL_OUTPUT_CAP_DEFAULT } = loadTs('src/main/toolOutputCondense.ts');
const { DEFAULT_KEY_REGISTRY } = loadTs('src/main/claims/registry.ts');
const { MemoryEngine } = loadTs('src/main/nativeMemory/engine.ts');
const { NativeMemoryClient } = loadTs('src/main/nativeMemory/service.ts');

const SHA_A = '1234abc' + 'd'.repeat(33);
const SHA_B = '9876fed' + 'e'.repeat(33);
const SHA_T = 'abcdef0' + '1'.repeat(33);
const c = (id, agent, key, at, text, extra = {}) => ({ t: 'claim', id, at, wt: at, agent, kind: 'fact', key, text, source: 'note', ...extra });
const mail = (id, from, to, act, subject, created_at, body) => JSON.stringify({ v: 1, id, card: 'FOO-7', cards: ['FOO-7'], cardFrom: 'field', from, to, act, subject, created_at, deliveredAt: 1, bodyHash: 'h', trust: 'delivery', ...(body === undefined ? {} : { body }) });
const lines = (t) => t.replace(/\n$/, '').split('\n');

function fixture(decisions = 3, extraCards = []) {
  const derived = [
    // L1 (Creed): every derived field claim carries its structured `value` beside the prose (donesha: `valueAgent` too).
    c('c-aaaaaaaaaaa1', 'derived', 'card.foo-7.donesha', '2026-10-01T10:00:00.000Z', `Card FOO-7: the newest done mail from alpha-1 (m1) names commit 1234abc (${SHA_A})`, { refs: [{ type: 'commit', value: SHA_A }], value: SHA_A, valueAgent: 'alpha-1' }),
    c('c-aaaaaaaaaaa2', 'derived', 'card.foo-7.donesha', '2026-10-02T10:00:00.000Z', `Card FOO-7: the newest done mail from beta-2 (m2) names commit 9876fed (${SHA_B})`, { refs: [{ type: 'commit', value: SHA_B }], value: SHA_B, valueAgent: 'beta-2' }),
    c('c-aaaaaaaaaaa5', 'derived', 'card.foo-7.status', '2026-10-02T12:00:00.000Z', 'Card FOO-7 ("Foo seven") status: doing', { value: 'doing' }),
    c('c-aaaaaaaaaaa7', 'derived', 'card.foo-7.lastsha', '2026-10-02T13:00:00.000Z', `Card FOO-7: the branch tip is ${SHA_A}`, { value: SHA_A }),
    c('c-aaaaaaaaaab1', 'derived', 'card.foo-7.audit', '2026-10-05T11:00:00.000Z', `Card FOO-7 audit: PASS at ${SHA_T} (Jim)`, { value: `PASS ${SHA_T}` }),
    c('c-aaaaaaaaaaa8', 'derived', 'release.1.1.98', '2026-10-05T13:00:00.000Z', 'release 1.1.98 cut at 7777777 (git tag v1.1.98)'),
    c('c-aaaaaaaaaab2', 'derived', 'release.1.1.98.tag', '2026-10-05T13:00:00.000Z', `release 1.1.98: tag v1.1.98 is commit ${SHA_T}`, { value: SHA_T }),
    c('c-aaaaaaaaaab3', 'derived', 'release.1.1.98.bump', '2026-10-04T13:00:00.000Z', `release 1.1.98: the version bump is commit ${SHA_B}`, { value: SHA_B }),
    c('c-aaaaaaaaaaa9', 'derived', 'release.1.1.98.pause', '2026-10-06T13:00:00.000Z', 'release 1.1.98 paused: the Human asked for a hold'),
  ];
  for (let i = 0; i < decisions; i++) derived.push(c(`c-dddddddd${String(i).padStart(4, '0')}`, 'derived', `card.foo-7.decision.ab${String(i).padStart(6, '0')}`, `2026-09-${String(1 + (i % 28)).padStart(2, '0')}T11:00:00.000Z`, `Human decision on FOO-7: asked "q${i}"; the Human answered "a${i}"`, { kind: 'decision' }));
  const ledgers = {
    derived,
    'alpha-1': [
      c('c-bbbbbbbbbbb1', 'alpha-1', 'card.foo-7', '2026-09-30T10:00:00.000Z', 'FOO-7 build is at 1111111 on branch x'),
      c('c-bbbbbbbbbbb2', 'alpha-1', 'card.foo-7', '2026-10-03T10:00:00.000Z', 'FOO-7 build moved to 2222222 on branch x', { supersedes: ['c-bbbbbbbbbbb1'], supersedesReason: { category: 'changed' } }),
      c('c-bbbbbbbbbbb3', 'alpha-1', 'card.foo-7.merge', '2026-10-04T10:00:00.000Z', 'guppy/foo-7 merged into guppy/main as 3333333'),
    ],
    'beta-2': [c('c-ccccccccccc1', 'beta-2', 'card.foo-7', '2026-10-01T09:00:00.000Z', 'FOO-7: beta thinks the build is 1111111 still')],
  };
  for (const [id, text] of extraCards) ledgers['beta-2'].push(c(`c-e${id.replace(/[^a-z0-9]/g, '').padEnd(11, 'f').slice(0, 11)}`, 'beta-2', `card.${id}`, '2026-10-02T09:00:00.000Z', text));
  const tasks = [{ id: 'FOO-7', status: 'doing', assignee: 'alpha-1', title: 'Foo seven', fixVersion: '1.1.103', tags: ['x'] }, { id: 'cut-1.1.100', status: 'done', title: 'Dotted' }];
  return { ledgers, tasks };
}
const deps = (over = {}, decisions = 3, extraCards = []) => { const f = fixture(decisions, extraCards); return { ledgers: f.ledgers, registry: JSON.parse(JSON.stringify(DEFAULT_KEY_REGISTRY)), reconcileItems: [], tasks: f.tasks, mailRows: () => null, ruleConfig: { r4: false }, ...over }; };
const get = (term, opts = {}, d = deps()) => G.resolveGet(term, opts, d);
const text = (term, opts = {}, d = deps()) => G.formatGet(G.resolveGet(term, opts, d), opts);
const SHA7 = /(?<![0-9a-z_])[0-9a-f]{7,}(?![0-9a-z_])/i; // a hex run joined by `_` is no sha (c_<12 hex>, …-merge_<sha>)
/** L5: the reply's `label:` lines outside the lead block are only the section labels. */
const SECTION = /^(current|competing|superseded|decisions|fields|mails|sources|superseded by|history|no claim|no mails?)\b/;

test('R1 caps: the get text\'s budget equals the compact search budget and stays under the condenser cap', () => {
  assert.equal(G.GET_MAX_CHARS, F.COMPACT_MAX_CHARS);
  assert.equal(G.GET_LINE_MAX, F.COMPACT_LINE_MAX);
  assert.ok(G.GET_MAX_CHARS < TOOL_OUTPUT_CAP_DEFAULT, `${G.GET_MAX_CHARS} < ${TOOL_OUTPUT_CAP_DEFAULT}`);
  assert.deepEqual([...G.CARD_FIELDS], ['donesha', 'lastsha', 'status', 'assignee', 'fixVersion', 'merge', 'audit'], 'L4: audit joins the card fields');
  assert.deepEqual([...G.PER_AGENT_FIELDS], ['donesha']); assert.deepEqual([...G.RELEASE_FIELDS], ['tag', 'bump']);
});

test('L2 + L3 lead: a bare card leads with `field: <value>` from the STRUCTURED value, in order; donesha prints a latest line and one line per agent, newest first; then the decision count', () => {
  const r = get('FOO-7');
  assert.deepEqual(r.lead.map((l) => [l.field, l.by ?? null, l.latest === true, l.source, l.id ?? null, l.value]), [
    ['donesha', 'beta-2', true, 'claim', 'c-aaaaaaaaaaa2', SHA_B], ['donesha', 'beta-2', false, 'claim', 'c-aaaaaaaaaaa2', SHA_B], ['donesha', 'alpha-1', false, 'claim', 'c-aaaaaaaaaaa1', SHA_A],
    ['lastsha', null, false, 'claim', 'c-aaaaaaaaaaa7', SHA_A], ['status', null, false, 'claim', 'c-aaaaaaaaaaa5', 'doing'],
    ['assignee', null, false, 'tasks', null, 'alpha-1'], ['fixVersion', null, false, 'tasks', null, '1.1.103'],
    ['merge', null, false, 'claim', 'c-bbbbbbbbbbb3', null], ['audit', null, false, 'claim', 'c-aaaaaaaaaab1', `PASS ${SHA_T}`],
  ], 'MUTANT: a field answered by nothing, out of order, a prose value, or the asked agent ignored');
  assert.equal(r.lead[7].key, 'card.foo-7.merge');
  const L = lines(text('FOO-7'));
  assert.match(L[0], /^get foo-7 → keys: card\.foo-7, /);
  assert.equal(L[1], `donesha (latest): ${SHA_B} by beta-2`);
  assert.equal(L[2], `donesha (beta-2): ${SHA_B}`);
  assert.equal(L[3], `donesha (alpha-1): ${SHA_A}`);
  assert.equal(L[4], `lastsha: ${SHA_A}`);
  assert.equal(L[5], 'status: doing', 'MUTANT: the prose (title, card id) on the line');
  assert.equal(L[6], 'assignee: alpha-1');
  assert.equal(L[7], 'fixVersion: 1.1.103');
  assert.equal(L[8], 'merge: not structured yet', 'an agent\'s own merge claim has no structured value: no window on its prose');
  assert.equal(L[9], `audit: PASS ${SHA_T}`);
  assert.equal(L[10], 'decisions: 3 (--all lists them)');
  assert.match(L[13], /^current: card\.foo-7: FOO-7 build moved to 2222222 on branch x$/);
  assert.equal(L[15], 'competing: 1 other live value hidden (--all lists them)', 'competing stays a count by default');
  assert.doesNotMatch(text('FOO-7'), /^decisions \(3\):|^  card\.foo-7\.decision\./m, 'MUTANT: the decision list in the default view');
  // L2: no title, no card id, no claim id, no source bracket on a lead line; a value line holds exactly one value.
  for (const l of L.slice(1, 11)) { assert.doesNotMatch(l, /foo-7|Foo seven|c-[0-9a-f]{12}|\[claim|\[mail|\[tasks/i, l); assert.ok((l.match(SHA7) || []).length <= 1, l); }
  // A structured merge (the derived writer's) prints its tip; a newer per-agent value sorts first.
  const d = deps();
  d.ledgers.derived.push(c('c-aaaaaaaaaab4', 'derived', 'card.foo-7.merge', '2026-10-09T10:00:00.000Z', `guppy/foo-7 merged into guppy/main, tip ${SHA_T}`, { value: SHA_T }));
  d.ledgers.derived.push(c('c-aaaaaaaaaab5', 'derived', 'card.foo-7.donesha', '2026-10-10T10:00:00.000Z', `Card FOO-7: the newest done mail from gamma-3 (m9) names commit abcdef0 (${SHA_T})`, { value: SHA_T, valueAgent: 'gamma-3' }));
  const M = lines(text('FOO-7', {}, d));
  assert.deepEqual(M.slice(1, 5), [`donesha (latest): ${SHA_T} by gamma-3`, `donesha (gamma-3): ${SHA_T}`, `donesha (beta-2): ${SHA_B}`, `donesha (alpha-1): ${SHA_A}`], 'MUTANT: oldest first, or one agent dropped');
  assert.equal(M[9], `merge: ${SHA_T}`);
  assert.equal(get('FOO-7', {}, d).lead.length, 10);
});

test('L3 --agent: the asked agent\'s own donesha line (and latest), nothing of the others; an agent without one says none; the mail rule\'s newer done mail joins as its sender\'s value', () => {
  const rows = [mail('2026-10-08T09-00-00-000Z-ffffff', 'alpha-1', 'god', 'done', 'FOO-7 done', '2026-10-08T09:00:00.000Z', `landed as ${'ABC1234F'.repeat(5)}`)];
  const withMail = deps({ mailRows: (card) => (card === 'foo-7' ? rows : null) });
  const r = get('FOO-7', {}, withMail);
  assert.deepEqual(r.lead.slice(0, 3).map((l) => [l.by, l.latest === true, l.source, l.id, l.value]), [
    ['alpha-1', true, 'mail', '2026-10-08T09-00-00-000Z-ffffff', 'abc1234f'.repeat(5)], ['alpha-1', false, 'mail', '2026-10-08T09-00-00-000Z-ffffff', 'abc1234f'.repeat(5)], ['beta-2', false, 'claim', 'c-aaaaaaaaaaa2', SHA_B],
  ], 'the mail names the newest sha for alpha-1 (lowercased); beta-2 keeps its claim');
  assert.equal(r.lead[0].value, get('card.foo-7.donesha', {}, withMail).current.value, 'the lead is what the field get says');
  assert.equal(r.lead[3].source, 'claim', 'lastsha takes no mail (G1)');
  const L = lines(text('FOO-7', {}, withMail));
  assert.equal(L[1], `donesha (latest): ${'abc1234f'.repeat(5)} by alpha-1`); assert.equal(L[2], `donesha (alpha-1): ${'abc1234f'.repeat(5)}`); assert.equal(L[3], `donesha (beta-2): ${SHA_B}`);
  assert.match(L.find((l) => l.startsWith('sources:')), /^sources: donesha \(alpha-1\) 2026-10-08T09-00-00-000Z-ffffff; donesha \(beta-2\) c_aaaaaaaaaaa2; /);
  assert.equal(get('FOO-7', { noMail: true }, withMail).lead[0].id, 'c-aaaaaaaaaaa2', '--no-mail: claims only, in the lead too');
  const A = lines(text('FOO-7', { agent: 'alpha-1' }, withMail));
  assert.deepEqual(A.slice(1, 4), [`donesha (latest): ${'abc1234f'.repeat(5)} by alpha-1`, `donesha (alpha-1): ${'abc1234f'.repeat(5)}`, `lastsha: ${SHA_A}`], 'MUTANT: the asked agent ignored (Jim a293f7, 19 rows)');
  assert.doesNotMatch(text('FOO-7', { agent: 'alpha-1' }, withMail), /beta-2/);
  const B = lines(text('FOO-7', { agent: 'beta-2' }));
  assert.deepEqual(B.slice(1, 3), [`donesha (latest): ${SHA_B} by beta-2`, `donesha (beta-2): ${SHA_B}`]);
  assert.equal(lines(text('FOO-7', { agent: 'gamma-3' }))[1], 'donesha (gamma-3): none');
  assert.equal(get('FOO-7', { agent: 'gamma-3' }).lead.length, 7);
});

test('L2 none / sub-key: an unanswered field says none; a field sub-key the agent typed has no lead; a release sub-key has none', () => {
  const d = deps({ tasks: [{ id: 'FOO-7', status: 'doing' }] });
  const L = lines(text('foo-7', {}, d));
  assert.equal(L[6], 'assignee: none'); assert.equal(L[7], 'fixVersion: none');
  assert.doesNotMatch(L.find((l) => l.startsWith('sources:')), /assignee|fixVersion/, 'a none line has no source');
  assert.equal(get('card.foo-7.donesha').lead, null, 'a sub-key is the field');
  assert.doesNotMatch(text('card.foo-7.donesha'), /^lastsha: |^sources: /m);
  assert.doesNotMatch(text('card.foo-7.status'), /^decisions/m, 'a sub-key with no decisions prints no count');
  assert.equal(get('release.1.1.98.pause').lead, null);
  assert.equal(get('release.1.1.98.tag').lead, null);
});

test('L2 lead value: a structured value prints whole (clipped only past its own cap, never a window on prose); a claim with no value yields to a newer structured one under the key', () => {
  assert.equal(G.leadValue('short value', 80), 'short value');
  const head = `${'word '.repeat(30)}tail`;
  assert.equal(G.leadValue(head, 40), `${head.slice(0, 39)}…`);
  const late = `${'subject words '.repeat(8)}— landed as ${SHA_B} and more`;
  assert.equal(G.leadValue(late, 60), `${late.slice(0, 59)}…`, 'MUTANT: a window cut from the prose');
  const d = deps();
  d.ledgers['alpha-1'].push(c('c-bbbbbbbbbbb4', 'alpha-1', 'card.foo-7.lastsha', '2026-10-09T10:00:00.000Z', `FOO-7 tip now ${SHA_T}, says alpha`));
  const r = get('FOO-7', {}, d);
  const ls = r.lead.find((l) => l.field === 'lastsha');
  assert.equal(ls.value, SHA_A); assert.equal(ls.id, 'c-aaaaaaaaaaa7', 'the agent\'s prose claim is newer but unstructured: the structured value answers');
  assert.equal(lines(text('FOO-7', {}, d))[4], `lastsha: ${SHA_A}`);
});

test('L5 format: the lead block is the only `label:` text; no claim id on a value line; the ids sit on one sources: line, wrapped not clipped, with no bare 7+ hex run; a c_ id resolves back', () => {
  const t = text('FOO-7');
  const L = lines(t);
  const srcAt = L.findIndex((l) => l.startsWith('sources:'));
  assert.equal(srcAt, 11, 'after the lead and the decision count');
  assert.equal(L[11], 'sources: donesha (beta-2) c_aaaaaaaaaaa2; donesha (alpha-1) c_aaaaaaaaaaa1; lastsha c_aaaaaaaaaaa7; status c_aaaaaaaaaaa5; assignee tasks.json;');
  assert.equal(L[12], '  fixVersion tasks.json; merge c_bbbbbbbbbbb3; audit c_aaaaaaaaaab1', 'MUTANT: the sources line clipped at GET_LINE_MAX (ids lost) instead of wrapped');
  for (const l of L.slice(11, 13)) { assert.doesNotMatch(l, SHA7, l); assert.ok(l.length <= G.GET_LINE_MAX); }
  for (const l of L.slice(13)) if (/^[a-zA-Z][a-zA-Z ()-]*: /.test(l)) assert.match(l, SECTION, `a body line with a field label: ${l}`);
  for (const l of L.slice(1, 11)) assert.doesNotMatch(l, /c[-_][0-9a-f]{12}/, l);
  assert.deepEqual(G.sourcesLines([]), []);
  const many = Array.from({ length: 30 }, (_, i) => ({ field: `f${i}`, value: 'v', source: 'claim', id: `c-${String(i).padStart(12, '0')}` }));
  const S = G.sourcesLines(many);
  assert.ok(S.length >= 3 && S[0].startsWith('sources: ') && S.slice(1).every((l) => /^ {2}f\d+ c_/.test(l)), S.join('|'));
  for (const l of S) assert.ok(l.length <= G.GET_LINE_MAX, l);
  assert.equal(S.join(' ').match(/c_\d{12}/g).length, 30, 'every id survives');
  assert.equal(G.safeId('c-be6e7c6f41b9'), 'c_be6e7c6f41b9');
  assert.equal(G.safeId('2026-10-26T05-28-27-422Z-fada64'), '2026-10-26T05-28-27-422Z-fada64', 'a mail id with a 6-hex tail is no sha');
  assert.equal(G.safeId('2026-10-26T05-28-27-422Z-c90-merge-abcdef0'), '2026-10-26T05-28-27-422Z-c90-merge_abcdef0');
  assert.equal(get('c_aaaaaaaaaaa5').keys[0], 'card.foo-7.status', 'the sha-proof spelling resolves as the claim id');
  assert.equal(get('c_aaaaaaaaaaa5').current.claimId, 'c-aaaaaaaaaaa5');
});

test('R1 cap by construction: 60 decisions, 50 mails, a long key list and long values stay under GET_MAX_CHARS, every line under GET_LINE_MAX, the lead block first and a pointer to --all', () => {
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push(mail(`2026-10-0${1 + (i % 9)}T0${i % 10}-00-${String(i).padStart(2, '0')}-000Z-${String(i).padStart(6, 'a')}`, 'alpha-1', 'god', 'inform', `FOO-7 ${'long subject '.repeat(12)}${i}`, `2026-10-0${1 + (i % 9)}T0${i % 10}:00:${String(i % 60).padStart(2, '0')}.000Z`, `body ${i} ${'words '.repeat(80)}`));
  const d = deps({ mailRows: (card) => (card === 'foo-7' ? rows : null), tasks: [{ id: 'FOO-7', status: 'doing', assignee: 'alpha-1', title: 'T '.repeat(120), fixVersion: '1.1.103' }] }, 60);
  const t = text('FOO-7', { mail: 50 }, d);
  assert.ok(t.length <= G.GET_MAX_CHARS, `${t.length} <= ${G.GET_MAX_CHARS} (MUTANT: no cap)`);
  for (const l of lines(t)) assert.ok(l.length <= G.GET_LINE_MAX, `${l.length}: ${l}`);
  const L = lines(t);
  assert.match(L[1], /^donesha \(latest\): /); assert.equal(L[10], 'decisions: 60 (--all lists them)');
  assert.match(L[L.length - 1], /^… \d+ more lines \(--all prints everything\)$/, 'MUTANT: no pointer');
  const full = text('FOO-7', { mail: 50, history: true }, d);
  assert.ok(full.length > G.GET_MAX_CHARS, 'the --all view is uncapped');
  assert.match(full, /^decisions \(60\):$/m);
  assert.equal(lines(full).filter((l) => /^  card\.foo-7\.decision\./.test(l)).length, 60);
  assert.match(full, /^donesha \(latest\): /m, 'the lead block stays in the --all view');
  assert.match(full, /^  mail: 2026-10-0\dT0\d-00-\d\d-000Z-[a-z0-9]{6} alpha-1 → god inform — FOO-7 long subject /m, 'L5: a mail row is labelled mail:, its id never before a colon');
  assert.equal(get('FOO-7', {}, d).lead.length, 9);
});

test('R1 / L4 same shape: guppy/<branch> leads with the card\'s fields; release.<v> leads with tag: and bump:; a plain key has no lead', () => {
  const b = get('guppy/foo-7');
  assert.deepEqual(b.keys, ['card.foo-7.merge']); assert.equal(b.card, 'foo-7');
  assert.deepEqual(b.lead.map((l) => l.field), ['donesha', 'donesha', 'donesha', 'lastsha', 'status', 'assignee', 'fixVersion', 'merge', 'audit']);
  const bt = lines(text('origin/guppy/FOO-7'));
  assert.equal(bt[8], 'merge: not structured yet');
  assert.equal(bt[10], 'decisions: 3 (--all lists them)');
  const r = get('release.1.1.98');
  assert.deepEqual(r.lead, [
    { field: 'tag', key: 'release.1.1.98.tag', value: SHA_T, source: 'claim', id: 'c-aaaaaaaaaab2', agent: 'derived', at: '2026-10-05T13:00:00.000Z' },
    { field: 'bump', key: 'release.1.1.98.bump', value: SHA_B, source: 'claim', id: 'c-aaaaaaaaaab3', agent: 'derived', at: '2026-10-04T13:00:00.000Z' },
  ], 'MUTANT: no bump / tag line (Jim a293f7 cause 5)');
  assert.deepEqual(lines(text('release.1.1.98')).slice(1, 5), [`tag: ${SHA_T}`, `bump: ${SHA_B}`, 'sources: tag c_aaaaaaaaaab2; bump c_aaaaaaaaaab3', 'current: release.1.1.98: release 1.1.98 cut at 7777777 (git tag v1.1.98)']);
  const d = deps(); d.ledgers.derived = d.ledgers.derived.filter((x) => x.key !== 'release.1.1.98.bump');
  assert.deepEqual(lines(text('release.1.1.98', {}, d)).slice(1, 3), [`tag: ${SHA_T}`, 'bump: none']);
  assert.equal(get('c-bbbbbbbbbbb2').lead.length, 9, 'a claim id of the bare card resolves to the card: the lead too');
  assert.equal(get('card.foo-7.decision.ab000000').lead, null);
});

test('R2 brief + cardIdOfKey: the brief lists the fields with a value (a per-agent field by its latest) and the decision count; the key→card map strips a known field suffix', () => {
  assert.deepEqual(G.leadBrief(get('FOO-7')), [
    `donesha: ${SHA_B}`, `lastsha: ${SHA_A}`, 'status: doing', 'assignee: alpha-1', 'fixVersion: 1.1.103', `audit: PASS ${SHA_T}`, 'decisions: 3',
  ], 'MUTANT: a prose window, every per-agent line, or the unstructured merge in the brief');
  assert.deepEqual(G.leadBrief(get('card.foo-7.status')), []);
  assert.deepEqual(G.leadBrief(get('release.1.1.98')), [`tag: ${SHA_T}`, `bump: ${SHA_B}`]);
  for (const [k, id] of [['card.foo-7', 'foo-7'], ['card.foo-7.donesha', 'foo-7'], ['card.foo-7.audit', 'foo-7'], ['card.FOO-7.decision.abcd1234', 'foo-7'], ['card.cut-1.1.100', 'cut-1.1.100'], ['card.cut-1.1.100.status', 'cut-1.1.100'], ['release.1.1.98', null], ['card.', null]]) {
    assert.equal(G.cardIdOfKey(k), id, k);
  }
  const many = G.resolveGetMany(['foo-7', 'nope-1', 'card.foo-7.status'], { mail: 0 }, deps());
  assert.equal(many.length, 3); assert.equal(many[0].lead.length, 9); assert.equal(many[1].keys.length, 0); assert.equal(many[2].lead, null);
});

// ---- R2 render ----
const lorem = (n, seed) => Array.from({ length: n }, (_, i) => `synthetic-${seed}-w${i}`).join(' ');
const hit = (i, status, key, date, content, extra = {}) => ({ chunkId: i, wing: 'wing-x', room: 'memory', source: 'claim', content, cosineSim: 0.5, bm25: -1, score: 1,
  claim: { id: `c-synth${String(i).padStart(8, '0')}`, status, kind: 'fact', key, at: `${date}T00:00:00.000Z` }, ...extra });
const chunk = (i, content) => ({ chunkId: i, wing: 'wing-x', room: 'general', source: 'agents/wing-x/NOTES.md', content, cosineSim: 0.4, bm25: 0.9, score: 0.9 });
const LEADS = { 'foo-7': ['donesha: 9876fed', 'status: doing', 'assignee: alpha-1', 'decisions: 3'], 'bar-9': ['status: done'] };

test('R2 compact: the first hit of a card carries `<id> now: …` once per card, inside the budget; a plain key or chunk carries nothing; the footer and order are unchanged', () => {
  const hits = [
    hit(1, 'live', 'card.foo-7.donesha', '2026-10-02', 'done sha 9876fed ' + lorem(12, 'a')),
    hit(2, 'live', 'card.foo-7', '2026-10-03', 'build moved to 2222222 ' + lorem(12, 'b')),
    chunk(3, '## note\n- about foo-7 ' + lorem(8, 'c')),
    hit(4, 'live', 'synthetic.port', '2026-10-10', 'port 2222 ' + lorem(6, 'd')),
    hit(5, 'superseded', 'card.bar-9', '2026-09-01', 'bar old ' + lorem(4, 'e')),
  ];
  const plain = F.formatSearch('foo-7 build', {}, hits);
  const t = F.formatSearch('foo-7 build', {}, hits, LEADS);
  const L = lines(t);
  assert.ok(t.length <= F.COMPACT_MAX_CHARS + F.COMPACT_GET_MAX, `${t.length}`);
  assert.equal(L.filter((l) => /^ {4}foo-7 now: /.test(l)).length, 1, 'MUTANT: the brief on every hit, or on none');
  const metas = L.filter((l) => /^\[\d\] /.test(l));
  assert.deepEqual(metas.map((l) => l.split(' · ')[2]), lines(plain).filter((l) => /^\[\d\] /.test(l)).map((l) => l.split(' · ')[2]), 'the order is the M3 order, briefs or not');
  const first = L.findIndex((l) => l.startsWith('[1] '));
  const second = L.findIndex((l) => l.startsWith('[2] '));
  const brief = L.slice(first, second).find((l) => /^ {4}foo-7 now: /.test(l));
  assert.equal(brief, '    foo-7 now: donesha: 9876fed · status: doing · assignee: alpha-1 · decisions: 3', 'under the FIRST printed hit of the card, after its content');
  assert.ok(L.indexOf(brief) > first + 1, 'the content line comes before the brief');
  assert.match(L[L.indexOf(metas[4]) + 2], /^ {4}bar-9 now: status: done$/, 'a prior hit still names the card\'s CURRENT values');
  assert.doesNotMatch(t, / {4}synthetic\.port now:/);
  assert.equal(L[L.length - 1], lines(plain)[lines(plain).length - 1], 'the get footer is unchanged');
  for (const l of L) assert.ok(l.length <= F.COMPACT_LINE_MAX, l);
  assert.equal(F.formatSearch('foo-7 build', {}, hits, {}), plain, 'no leads: byte-identical to before');
});

test('R2 compact budget: on a tight share the brief drops fields from its end, never pushes the content under one line or the matched term off it, and is left out when not one field fits', () => {
  const hits = [];
  for (let i = 1; i <= 12; i++) hits.push(hit(i, 'live', `card.card-${i}`, '2026-10-02', `${lorem(6, `h${i}`)} value-${i} ${lorem(30, `t${i}`)}`));
  const leads = {};
  for (let i = 1; i <= 12; i++) leads[`card-${i}`] = ['donesha: ' + 'f'.repeat(40), 'lastsha: ' + 'e'.repeat(40), 'status: doing', 'assignee: alpha-1', 'merge: ' + 'd'.repeat(40)];
  const t = F.formatSearch('value-12 value-11 value-3', {}, hits, leads);
  const L = lines(t);
  assert.ok(t.length <= F.COMPACT_MAX_CHARS + F.COMPACT_GET_MAX, `${t.length}`);
  for (const l of L) assert.ok(l.length <= F.COMPACT_LINE_MAX, l);
  const briefs = L.filter((l) => /^ {4}card-\d+ now: /.test(l));
  assert.ok(briefs.length >= 1, 'at least the first hit carries a brief');
  assert.ok(briefs.some((l) => !l.includes('merge:')), 'MUTANT: a brief never shortened');
  for (const m of L.filter((l) => /^\[\d+\] /.test(l))) {
    const n = Number(/^\[(\d+)\]/.exec(m)[1]);
    const i = L.indexOf(m);
    assert.match(L[i + 1], /^ {4}(?!card-\d+ now: )\S/, `hit ${n} keeps its content line first`);
    const key = m.split(' · ')[2];
    const id = key.slice('card.'.length);
    if (['card-12', 'card-11', 'card-3'].includes(id)) assert.ok(L.slice(i + 1, i + 4).some((l) => l.includes(`value-${id.split('-')[1]}`)), `hit ${n} (${id}) still shows its matched value`);
  }
});

test('R2 full: `--full` prints a Card: line after the Get: pointer', () => {
  const t = F.formatSearch('foo-7', { full: true }, [hit(1, 'live', 'card.foo-7.donesha', '2026-10-02', 'done sha 9876fed'), hit(2, 'live', 'synthetic.port', '2026-10-10', 'port 2222')], LEADS);
  assert.match(t, /^      Get:    memory get card\.foo-7\.donesha\n      Card:   foo-7 now: donesha: 9876fed · status: doing · assignee: alpha-1 · decisions: 3$/m);
  assert.equal((t.match(/Card:/g) || []).length, 1);
});

// ---- R2 engine + port ----
const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'c90-step3-'));
test.after(() => fs.rmSync(JAIL, { recursive: true, force: true }));
function fakeStore(hits) {
  return {
    setMeta() {}, sourceShas: () => new Map(), removeSource() {}, planDiff: () => ({ keep: [], add: [], remove: [] }), applyDiff: () => true, wakeUp: () => [],
    search: () => hits.map((h) => ({ ...h })), searchExact: () => hits.map((h) => ({ ...h })),
  };
}
const engineWith = (hits, cardLead) => new MemoryEngine({
  hiveRoot: JAIL, store: fakeStore(hits), embedder: { loaded: true, embed: async (x) => x.map(() => new Float32Array(384)), unload: async () => {} },
  countTokens: (t) => t.length, watch: null, setTimer: (fn, ms) => (ms === 0 ? setImmediate(fn) : { ms }), clearTimer: () => {}, ...(cardLead ? { cardLead } : {}),
});

test('R2 engine: the search asks the cardLead dep once with the distinct card ids of its hits, in hit order, and renders the briefs; no dep, a throw or a non-object leaves the text as before', async () => {
  const hits = [hit(1, 'live', 'card.foo-7.donesha', '2026-10-02', 'done sha 9876fed'), hit(2, 'live', 'card.foo-7', '2026-10-03', 'build moved'), hit(3, 'live', 'card.bar-9', '2026-10-04', 'bar current'), hit(4, 'live', 'synthetic.port', '2026-10-10', 'port 2222')];
  const calls = [];
  const e = engineWith(hits, async (cards) => { calls.push(cards); return LEADS; });
  const r = await e.search({ query: 'foo-7', results: 4 });
  assert.deepEqual(calls, [['foo-7', 'bar-9']]);
  assert.match(r.text, /^ {4}foo-7 now: donesha: 9876fed · status: doing/m);
  assert.match(r.text, /^ {4}bar-9 now: status: done$/m);
  const plain = (await engineWith(hits).search({ query: 'foo-7', results: 4 })).text;
  assert.doesNotMatch(plain, / now: /);
  assert.equal((await engineWith(hits, async () => { throw new Error('ledger gone'); }).search({ query: 'foo-7', results: 4 })).text, plain, 'a failing dep: the hits as before');
  assert.equal((await engineWith(hits, async () => null).search({ query: 'foo-7', results: 4 })).text, plain);
  assert.equal((await engineWith([hit(4, 'live', 'synthetic.port', '2026-10-10', 'port 2222')], async (cards) => { calls.push(cards); return {}; }).search({ query: 'port', results: 1 })).text.includes(' now: '), false);
  assert.equal(calls.length, 1, 'no card in the hits: the dep is not asked');
  const full = await e.search({ query: 'foo-7', results: 4, full: true });
  assert.match(full.text, /^      Card:   foo-7 now: /m);
  const exact = await e.search({ query: 'foo-7', results: 4, exact: true });
  assert.match(exact.text, /^ {4}foo-7 now: /m, 'the --exact path carries the briefs too');
});

test('L7: claims90-search.cjs --hive builds the briefs through main\'s claimCardLeadOver (hive-read deps) and the engine\'s own helpers: its text is byte-for-byte the engine\'s for the same hits', async () => {
  const { hiveCardLead, hiveReadDeps, searchTextOver } = require('./tools/claims90-hive-read.cjs');
  const { cardIdsOfHits, cardLeadsFor } = loadTs('src/main/nativeMemory/engine.ts');
  const root = path.join(JAIL, 'hive-l7');
  const f = fixture(3);
  for (const [agent, recs] of Object.entries(f.ledgers)) {
    fs.mkdirSync(path.join(root, 'agents', agent, 'memory', 'claims'), { recursive: true });
    fs.writeFileSync(path.join(root, 'agents', agent, 'memory', 'claims', '2026-10.jsonl'), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({ tasks: f.tasks }));
  const d = hiveReadDeps(root);
  assert.deepEqual(d.agents().sort(), ['alpha-1', 'beta-2', 'derived']); assert.equal(d.store.readLedger('derived').chain, 'ok'); assert.equal(d.store.readLedger('nope').records.length, 0);
  const hits = [hit(1, 'live', 'card.foo-7.donesha', '2026-10-02', 'done sha 9876fed ' + lorem(10, 'a')), hit(2, 'live', 'card.foo-7', '2026-10-03', 'build moved ' + lorem(10, 'b')), hit(3, 'live', 'synthetic.port', '2026-10-10', 'port 2222')];
  const lead = hiveCardLead(root);
  assert.deepEqual(cardIdsOfHits(hits), ['foo-7']);
  assert.deepEqual(await lead(['foo-7', 'nope-1']), { 'foo-7': [`donesha: ${SHA_B}`, `lastsha: ${SHA_A}`, 'status: doing', 'assignee: alpha-1', 'fixVersion: 1.1.103', `audit: PASS ${SHA_T}`, 'decisions: 3'] }, 'the hive\'s real values, through claimCardLeadOver');
  assert.deepEqual(await cardLeadsFor(hits, undefined), {}); assert.deepEqual(await cardLeadsFor(hits, async () => { throw new Error('x'); }), {});
  const flags = { results: 4, wing: null, room: null, since: null, before: null, full: false, exact: false, newest: false };
  const tool = await searchTextOver(root, 'foo-7 build', flags, hits);
  const engine = (await engineWith(hits, lead).search({ query: 'foo-7 build', ...flags })).text;
  assert.equal(tool, engine, 'MUTANT: the tool\'s text differs from the engine\'s');
  assert.match(tool, new RegExp(`^ {4}foo-7 now: donesha: ${SHA_B} · lastsha: ${SHA_A} · status: doing`, 'm'), 'the brief carries the structured values');
  assert.equal(await searchTextOver(null, 'foo-7 build', flags, hits), F.formatSearch('foo-7 build', flags, hits), 'no --hive: no brief, as before');
  const src = fs.readFileSync(path.join(REPO, 'test', 'tools', 'claims90-search.cjs'), 'utf8');
  assert.match(src, /const text = await searchTextOver\(hiveRoot, query, flags, hits\);/, 'the tool prints through the same helper');
  assert.doesNotMatch(src, /formatSearch\(/, 'no second format path in the tool');
});

function fakeWorker() {
  const w = { posted: [], handlers: { message: [], exit: [] } };
  w.postMessage = (m) => w.posted.push(m);
  w.on = (ev, fn) => w.handlers[ev].push(fn);
  w.kill = () => true;
  w.reply = (m) => w.handlers.message.forEach((f) => f(m));
  return w;
}
const tick = () => new Promise((r) => setImmediate(r));

test('R2 port: the client answers a worker\'s `{ ask, op, args }` through the ask dep as `{ answer, result }`; no dep, a throw or a rejection answers null; a request reply is untouched', async () => {
  const workers = [];
  const asked = [];
  const client = new NativeMemoryClient({ fork: () => { const w = fakeWorker(); workers.push(w); return w; }, config: () => ({ hiveRoot: 'h' }), now: () => 1, setTimer: () => ({}), clearTimer: () => {},
    ask: (op, args) => { asked.push([op, args]); if (op === 'boom') throw new Error('x'); if (op === 'reject') return Promise.reject(new Error('y')); return op === 'card-lead' ? { 'foo-7': ['status: doing'] } : null; } });
  const p = client.request('status', {});
  const w = workers[0];
  w.reply({ ask: 7, op: 'card-lead', args: { cards: ['foo-7'] } });
  await tick();
  assert.deepEqual(asked, [['card-lead', { cards: ['foo-7'] }]]);
  assert.deepEqual(w.posted.at(-1), { answer: 7, result: { 'foo-7': ['status: doing'] } });
  w.reply({ ask: 8, op: 'boom', args: {} }); await tick();
  assert.deepEqual(w.posted.at(-1), { answer: 8, result: null });
  w.reply({ ask: 9, op: 'reject' }); await tick();
  assert.deepEqual(w.posted.at(-1), { answer: 9, result: null });
  w.reply({ id: w.posted.find((m) => m.op === 'status').id, ok: true, exit: 0, text: 'T' });
  assert.equal((await p).text, 'T', 'an ordinary reply still resolves its request');
  const noDep = new NativeMemoryClient({ fork: () => { const x = fakeWorker(); workers.push(x); return x; }, config: () => ({ hiveRoot: 'h' }), now: () => 1, setTimer: () => ({}), clearTimer: () => {} });
  void noDep.request('status', {});
  workers.at(-1).reply({ ask: 1, op: 'card-lead', args: {} }); await tick();
  assert.deepEqual(workers.at(-1).posted.at(-1), { answer: 1, result: null });
});

test('R2 wiring (static): the worker asks main for `card-lead` and answers `{ answer }` messages; mainWiring routes `card-lead` to the cardLead dep; index.ts wires claimCardLeadOver; the worker passes --exact / --newest to the engine', () => {
  const src = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
  const worker = src('src/main/nativeMemory/worker.ts');
  assert.match(worker, /cardLead: async \(cards\) => \{ const r = await ask\('card-lead', \{ cards \}\);/);
  assert.match(worker, /typeof ans\.answer === 'number'/);
  assert.match(worker, /port\.postMessage\(\{ ask: id, op, args \}\)/);
  assert.match(worker, /exact: a\.exact === true, newest: a\.newest === true, kind: \(a\.kind as string\) \?\? null, key: \(a\.key as string\) \?\? null, full: a\.full === true \}/, 'MUTANT: --exact / --newest dropped between service.ts and the engine');
  const wiring = src('src/main/nativeMemory/mainWiring.ts');
  assert.match(wiring, /ask: \(op, args\) => \(op === 'card-lead' && d\.cardLead/);
  const index = src('src/main/index.ts');
  assert.match(index, /cardLead: \(cards\) => \{\s*const root = hive\.root\(\); const ep = claimsEndpoint\(\);/);
  assert.match(index, /return claimCardLeadOver\(\{ root, store: ep\.store, agents: claimLedgerAgents, tasks:/);
  const service = src('src/main/nativeMemory/service.ts');
  assert.match(service, /if \(q && typeof q\.ask === 'number'\) \{ this\.answer\(/);
});
