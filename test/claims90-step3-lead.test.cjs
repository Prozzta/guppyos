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
const E = loadTs('src/main/nativeMemory/engine.ts');
const { MemoryEngine } = E;
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
  assert.deepEqual([...G.CARD_FIELDS], ['donesha', 'lastsha', 'status', 'assignee', 'fixVersion', 'merge', 'merge.rc', 'audit'], 'L4: audit joins the card fields; god 234b13: the rc merge is its own field after the INT merge');
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
  assert.equal(M[9], `merge: ${SHA_T} into ? (not structured yet)`, 'R4: a merge value without its INT target is flagged');
  assert.equal(get('FOO-7', {}, d).lead.length, 10);
});

test('R4 merge (Jim cd199c, god 4268df): a merge value names the tip AND the INT line; one lead line per live merge claim, newest first; a value without its target says `into ? (not structured yet)`; the brief carries the newest whole', () => {
  const d = deps();
  d.ledgers.derived.push(c('c-aaaaaaaaaab6', 'derived', 'card.foo-7.merge', '2026-10-09T10:00:00.000Z', `guppy/foo-7 merged into int-1.1.103 as ${SHA_T}`, { value: `${SHA_T} into int-1.1.103` }));
  d.ledgers.derived.push(c('c-aaaaaaaaaab7', 'derived', 'card.foo-7.merge', '2026-10-07T10:00:00.000Z', `guppy/foo-7 merged into int-1.1.102 as ${SHA_B}`, { value: `${SHA_B} into int-1.1.102` }));
  const L = lines(text('FOO-7', {}, d));
  assert.equal(L[8], `merge: ${SHA_T} into int-1.1.103`, 'MUTANT: the target clipped off, or the tip alone');
  assert.equal(L[9], `merge: ${SHA_B} into int-1.1.102`, 'MUTANT: oldest first, or one merge dropped');
  assert.equal(L[10], `audit: PASS ${SHA_T}`);
  assert.ok(L[8].length <= G.GET_LINE_MAX);
  assert.deepEqual(G.MULTI_FIELDS, ['merge', 'merge.rc']);
  const r = get('FOO-7', {}, d);
  assert.equal(r.lead.length, 10); assert.deepEqual(r.lead.filter((l) => l.field === 'merge').map((l) => l.id), ['c-aaaaaaaaaab6', 'c-aaaaaaaaaab7']);
  const si = L.findIndex((l) => l.startsWith('sources:')); let S = L[si];
  for (let i = si + 1; i < L.length && L[i].startsWith('  '); i++) S += ` ${L[i].trim()}`;
  assert.match(S, /merge c_aaaaaaaaaab6;.*merge c_aaaaaaaaaab7/, 'the sources line names every merge claim, newest first');
  const brief = G.leadBrief(r);
  assert.ok(brief.includes(`merge: ${SHA_T} into int-1.1.103`), 'the brief carries both points too');
  assert.deepEqual(brief.filter((b) => b.startsWith('merge: ')), [`merge: ${SHA_T} into int-1.1.103`, `merge: ${SHA_B} into int-1.1.102`], 'S2: the brief carries every merge, newest first');
  assert.equal(G.leadBrief(get('card.foo-7.merge', {}, d)).length, 0);
  const bare = deps();
  bare.ledgers.derived.push(c('c-aaaaaaaaaab8', 'derived', 'card.foo-7.merge', '2026-10-09T10:00:00.000Z', `guppy/foo-7 merged as ${SHA_T}`, { value: SHA_T }));
  assert.equal(lines(text('FOO-7', {}, bare))[8], `merge: ${SHA_T} into ? (not structured yet)`, 'MUTANT: a tip alone passes as a merge');
  assert.ok(G.leadBrief(get('FOO-7', {}, bare)).includes(`merge: ${SHA_T} into ? (not structured yet)`));
  assert.equal(lines(text('release.1.1.98'))[2], `bump: ${SHA_B}`, 'only a merge value asks for a target');
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

const BRIEF_FOO = [`donesha (latest): ${SHA_B} by beta-2`, `donesha (beta-2): ${SHA_B}`, `donesha (alpha-1): ${SHA_A}`, `lastsha: ${SHA_A}`, 'status: doing', 'assignee: alpha-1', 'fixVersion: 1.1.103', `audit: PASS ${SHA_T}`, 'decisions: 3'];
test('S1 / S2 brief (god 7a4eec) + cardIdOfKey: the brief is get\'s lead lines byte for byte (label first, every per-agent donesha, every structured field, no unstructured one) and the decision count; the lines the query names (a field by a word for it, an agent by its id or first segment) come first', () => {
  assert.deepEqual(G.leadBrief(get('FOO-7')), BRIEF_FOO, 'MUTANT: a prose window, the per-agent lines dropped, the label without its agent, or the unstructured merge in the brief');
  const L = lines(text('FOO-7'));
  for (const b of BRIEF_FOO.slice(0, -1)) assert.ok(L.includes(b), `byte parity with get: ${b}`);
  assert.deepEqual(G.leadBrief(get('FOO-7'), 'FOO-7 audit verdict'), [`audit: PASS ${SHA_T}`, ...BRIEF_FOO.filter((b) => !b.startsWith('audit'))], 'MUTANT: the named field not first');
  assert.deepEqual(G.leadBrief(get('FOO-7'), 'alpha done sha'), BRIEF_FOO, 'the query names done (every donesha line) and alpha (its line): all three named, in get\'s order');
  assert.deepEqual(G.leadBrief(get('FOO-7'), 'alpha sha').slice(0, 3), [`donesha (alpha-1): ${SHA_A}`, `donesha (latest): ${SHA_B} by beta-2`, `donesha (beta-2): ${SHA_B}`], 'MUTANT: the named agent\'s line not first (sha names no field; the rest keep get\'s order)');
  assert.deepEqual(G.leadBrief(get('FOO-7'), 'alpha-1').slice(0, 2), [`donesha (alpha-1): ${SHA_A}`, `donesha (latest): ${SHA_B} by beta-2`]);
  assert.deepEqual(G.leadBrief(get('FOO-7'), 'merged into INT').slice(0, 1), [`donesha (latest): ${SHA_B} by beta-2`], 'an unstructured merge has no line to pull first');
  assert.deepEqual(G.leadBrief(get('FOO-7'), 'what is the tip of the branch').slice(0, 1), [`lastsha: ${SHA_A}`]);
  assert.deepEqual(G.leadBrief(get('card.foo-7.status')), []);
  assert.deepEqual(G.leadBrief(get('release.1.1.98')), [`tag: ${SHA_T}`, `bump: ${SHA_B}`]);
  for (const [k, id] of [['card.foo-7', 'foo-7'], ['card.foo-7.donesha', 'foo-7'], ['card.foo-7.audit', 'foo-7'], ['card.FOO-7.decision.abcd1234', 'foo-7'], ['card.cut-1.1.100', 'cut-1.1.100'], ['card.cut-1.1.100.status', 'cut-1.1.100'], ['release.1.1.98', null], ['card.', null]]) {
    assert.equal(G.cardIdOfKey(k), id, k);
  }
  const many = G.resolveGetMany(['foo-7', 'nope-1', 'card.foo-7.status'], { mail: 0 }, deps());
  assert.equal(many.length, 3); assert.equal(many[0].lead.length, 9); assert.equal(many[1].keys.length, 0); assert.equal(many[2].lead, null);
  assert.deepEqual(G.EMPTY_CARD_LEADS, { briefs: {}, named: [], pointed: [] });
});

// ---- R2 render ----
const lorem = (n, seed) => Array.from({ length: n }, (_, i) => `synthetic-${seed}-w${i}`).join(' ');
const hit = (i, status, key, date, content, extra = {}) => ({ chunkId: i, wing: 'wing-x', room: 'memory', source: 'claim', content, cosineSim: 0.5, bm25: -1, score: 1,
  claim: { id: `c-synth${String(i).padStart(8, '0')}`, status, kind: 'fact', key, at: `${date}T00:00:00.000Z` }, ...extra });
const chunk = (i, content) => ({ chunkId: i, wing: 'wing-x', room: 'general', source: 'agents/wing-x/NOTES.md', content, cosineSim: 0.4, bm25: 0.9, score: 0.9 });
const LEADS = { 'foo-7': ['donesha (latest): 9876fed by beta-2', 'donesha (beta-2): 9876fed', 'status: doing', 'assignee: alpha-1', 'decisions: 3'], 'bar-9': ['status: done'] };
/** The brief blocks of a compact text: `<id>` header (4 spaces) and its `field: value` lines (6 spaces). */
const briefBlocks = (L) => {
  const out = [];
  for (let i = 0; i < L.length; i++) if (/^ {4}[a-z0-9][a-z0-9._-]*$/.test(L[i])) { const b = { id: L[i].trim(), lines: [] }; while (/^ {6}\S/.test(L[i + 1] ?? '')) b.lines.push(L[++i].slice(6)); out.push(b); }
  return out;
};

test('S1 / M1 compact (god 7a4eec, 5dc648): the brief (an `<id>` header and label-first `field: value` lines, one per line) prints at the top for the card the QUERY names only; a card a hit is keyed to or names gets one label-free pointer line there; no brief ever prints under a hit, so leads without a named card change nothing', () => {
  const hits = [
    hit(1, 'live', 'card.foo-7.donesha', '2026-10-02', 'done sha 9876fed ' + lorem(12, 'a')),
    hit(2, 'live', 'card.foo-7', '2026-10-03', 'build moved to 2222222 ' + lorem(12, 'b')),
    chunk(3, '## note\n- about foo-7 ' + lorem(8, 'c')),
    hit(4, 'live', 'synthetic.port', '2026-10-10', 'port 2222 ' + lorem(6, 'd')),
    hit(5, 'superseded', 'card.bar-9', '2026-09-01', 'bar old ' + lorem(4, 'e')),
  ];
  const plain = F.formatSearch('foo-7 build', {}, hits);
  assert.equal(F.formatSearch('foo-7 build', {}, hits, LEADS), plain, 'MUTANT: field lines outside the named brief (a brief under a hit)');
  const t = F.formatSearch('foo-7 build', {}, hits, LEADS, ['foo-7'], ['bar-9', 'foo-7']);
  const L = lines(t);
  assert.ok(t.length <= F.COMPACT_MAX_CHARS + F.COMPACT_GET_MAX, `${t.length}`);
  assert.deepEqual(L.slice(1, 8), ['foo-7', '    donesha (latest): 9876fed by beta-2', '    donesha (beta-2): 9876fed', '    status: doing', '    assignee: alpha-1', '    decisions: 3', 'bar-9: memory get bar-9'], 'MUTANT: a line joined, a label dropped, the pointer missing, or a named card pointed too');
  assert.match(L[8], /^\[1\] /);
  assert.doesNotMatch(t, / now: /, 'MUTANT: the old one-line `<id> now:` brief');
  assert.doesNotMatch(t, /status: done/, 'MUTANT: the pointed card\'s field lines printed');
  assert.deepEqual(briefBlocks(L), [], 'MUTANT: a brief under a hit');
  const metas = L.filter((l) => /^\[\d\] /.test(l));
  assert.deepEqual(metas.map((l) => l.split(' · ')[2]), lines(plain).filter((l) => /^\[\d\] /.test(l)).map((l) => l.split(' · ')[2]), 'the order is the M3 order, briefs or not');
  assert.equal(L[L.length - 1], lines(plain)[lines(plain).length - 1], 'the get footer is unchanged');
  for (const l of L) assert.ok(l.length <= F.COMPACT_LINE_MAX, l);
  // Pointers only: no named card, one pointer line per card the hits carry, no field line anywhere.
  const p = lines(F.formatSearch('foo-7 build', {}, hits, LEADS, [], ['foo-7', 'bar-9']));
  assert.deepEqual(p.slice(1, 3), ['foo-7: memory get foo-7', 'bar-9: memory get bar-9'], 'MUTANT: pointers missing with no named card');
  assert.ok(!p.some((l) => /^ {0,6}[a-z]+( \([^)]*\))?: /.test(l) && !/: memory get /.test(l)), 'MUTANT: a field line with no named card');
  assert.deepEqual(p.filter((l) => /^\[\d\] /.test(l)).map((l) => l.split(' · ')[2]), metas.map((l) => l.split(' · ')[2]), 'the hits as before, under the pointers');
});

test('M3 / M3b body prefix (god 5dc648, 08992e): every hit-body line, compact and full, prints under the indent and `|: `, so a note line that starts with a field label never reads as a field line and the prefix carries the line\'s first separator; the brief lines are byte for byte as before', () => {
  assert.equal(F.BODY_PREFIX, '|: ');
  const note = 'merge: 1234567 into int-1.1.98\ndone: shipped\ntag: v1.1.98 ' + lorem(30, 'n');
  const hits = [hit(1, 'live', 'card.foo-7', '2026-10-03', note), chunk(2, '## note\nmerge: 7654321 into int-1.1.97 ' + lorem(40, 'c')), hit(3, 'live', 'synthetic.port', '2026-10-10', 'port 2222')];
  const t = F.formatSearch('foo-7 merge', {}, hits, LEADS, ['foo-7']);
  const L = lines(t);
  assert.deepEqual(L.slice(1, 7), ['foo-7', '    donesha (latest): 9876fed by beta-2', '    donesha (beta-2): 9876fed', '    status: doing', '    assignee: alpha-1', '    decisions: 3'], 'the brief unchanged');
  const bodies = [];
  for (let i = 7; i < L.length; i++) if (/^\[\d\] /.test(L[i])) { while (/^ {4}/.test(L[i + 1] ?? '')) bodies.push(L[++i]); }
  assert.ok(bodies.length >= 4, `${bodies.length} body lines`);
  for (const b of bodies) assert.match(b, /^ {4}\|: \S/, `MUTANT: a body line without the prefix: ${b}`);
  assert.match(t, /^ {4}\|: card\.foo-7: done: shipped tag: v1\.1\.98 /m, 'the lead line (the body after the heading line) under the prefix too');
  assert.doesNotMatch(t, /^ {4}(merge:|done:|tag:|card\.foo-7:|port |##|…)/m, 'MUTANT: a bare body line');
  assert.match(t, /^ {4}\|: (…|##|merge: 7654321)/m, 'the chunk body under the prefix');
  for (const l of L) assert.ok(l.length <= F.COMPACT_LINE_MAX, l);
  const full = F.formatSearch('foo-7 merge', { full: true }, hits, LEADS, ['foo-7']);
  assert.match(full, /^ {6}\|: card\.foo-7: done: shipped tag: .*\n\n {6}\|: merge: 1234567 into int-1\.1\.98\n {6}\|: done: shipped\n {6}\|: tag: v1\.1\.98 /m, 'MUTANT: --full prints a bare body line');
  assert.doesNotMatch(full, /^ {6}(merge|done|tag|port|card\.foo-7): /m);
  assert.match(full, /^ {6}\|: port 2222$/m);
  assert.match(full, /^  foo-7\n {6}donesha \(latest\): 9876fed by beta-2\n/m, 'full: the brief unchanged');
});

test('M3b (god 08992e, Jim f6c424): a body line whose words sit before its first `:` or `=` (`VERSION BUMP = x`, `- tag v = y`, `merge into z: w`) is no field line: the frozen label (everything before the first `:` or `=`) of every body line is the fixed prefix token, so the named brief\'s field lines are the only field lines in the reply', () => {
  const label = (l) => { const m = /^([^:=]*)[:=]/.exec(l); return m ? m[1].trim() : null; };
  const note = 'VERSION BUMP = FOUR PLACES (package, lock, hero, notes)\n- tag v1.1.55 = release-1.1.55 = abc1234\nready to merge into 1.1.48: YES';
  const hits = [hit(1, 'live', 'card.foo-7', '2026-10-03', note), chunk(2, '## bump\nVERSION BUMP = FOUR PLACES ' + lorem(30, 'b')), hit(3, 'live', 'synthetic.port', '2026-10-10', 'port 2222')];
  for (const [mode, t, briefIndent] of [['compact', F.formatSearch('foo-7 bump', {}, hits, LEADS, ['foo-7']), 4], ['full', F.formatSearch('foo-7 bump', { full: true }, hits, LEADS, ['foo-7']), 6]]) {
    const L = lines(t); const first = L.findIndex((l) => /^ {0,2}\[1\] /.test(l)); assert.ok(first > 0, `${mode}: a hit`);
    const briefLabels = L.slice(0, first).map(label).filter((x) => x !== null);
    assert.deepEqual(briefLabels.filter((x) => x !== 'Results for' && x !== 'Wing' && x !== 'Since'), ['donesha (latest)', 'donesha (beta-2)', 'status', 'assignee', 'decisions'], `${mode}: the brief field lines, byte for byte`);
    const bodies = L.slice(first).filter((l) => new RegExp(`^ {${briefIndent}}\\S`).test(l) && !/^ {6}(Source|Match|Get|Card):/.test(l));
    assert.ok(bodies.length >= 3, `${mode}: ${bodies.length} body lines`);
    for (const b of bodies) assert.equal(label(b), '|', `MUTANT (${mode}): a body line whose label is body text: ${b}`);
    for (const b of bodies) assert.doesNotMatch(b, /^ *\|: (VERSION BUMP|- tag v1\.1\.55|ready to merge)[^:=]*$/, `${mode}: the separator sits in the prefix, the body text keeps its own: ${b}`);
    assert.ok(L.slice(first).some((l) => /\|: VERSION BUMP = FOUR PLACES/.test(l)) && L.slice(first).some((l) => /\|: - tag v1\.1\.55 = release-1\.1\.55 = abc1234|\|: .*ready to merge into 1\.1\.48: YES/.test(l)), `${mode}: the bodies print whole under the prefix`);
  }
});

test('S1 / M1 full: `--full` prints the Get: pointer then Match: (no Card: block under a hit any more); the named brief and the pointers sit in the block after the header', () => {
  const hits = [hit(1, 'live', 'card.foo-7.donesha', '2026-10-02', 'done sha 9876fed'), hit(2, 'live', 'card.bar-9', '2026-10-10', 'bar 2222')];
  const t = F.formatSearch('foo-7', { full: true }, hits, LEADS, ['foo-7'], ['bar-9']);
  assert.match(t, /^      Get:    memory get card\.foo-7\.donesha\n      Match:/m);
  assert.doesNotMatch(t, /Card:/, 'MUTANT: a brief under a hit');
  const FL = lines(t); const head = FL.indexOf('='.repeat(60), 2);
  assert.deepEqual(FL.slice(head + 2, head + 9), ['  foo-7', '      donesha (latest): 9876fed by beta-2', '      donesha (beta-2): 9876fed', '      status: doing', '      assignee: alpha-1', '      decisions: 3', '  bar-9: memory get bar-9'], 'MUTANT: the named block or the pointer missing');
  assert.doesNotMatch(t, /status: done/, 'MUTANT: the pointed card\'s field lines');
  assert.match(t, /^ {6}\|: done sha 9876fed$/m, 'the body under the prefix');
  assert.equal(F.formatSearch('foo-7', { full: true }, hits, LEADS), F.formatSearch('foo-7', { full: true }, hits), 'leads without a named card change nothing');
});

test('S3 / M1 named (god 7a4eec, 5dc648): the briefs of the terms the QUERY names print at the top above every hit, compact and full, EACH whole (BRIEF_LINES_MAX lines), in the named order; the terms the hits name follow as `memory get` pointers; a named card is never pointed too; no hits still shows them', () => {
  const hits = [hit(1, 'live', 'card.foo-7.donesha', '2026-10-02', 'done sha 9876fed ' + lorem(12, 'a')), hit(2, 'live', 'card.bar-9', '2026-10-03', 'bar ' + lorem(12, 'b')), chunk(3, 'note ' + lorem(8, 'c'))];
  const leads = { ...LEADS, 'release.1.1.98': ['tag: ' + 'a'.repeat(40), 'bump: ' + 'b'.repeat(40)] };
  const t = F.formatSearch('foo-7 build', {}, hits, leads, ['release.1.1.98', 'foo-7'], ['bar-9', 'foo-7']);
  const L = lines(t);
  assert.deepEqual(L.slice(1, 9), ['release.1.1.98', '    tag: ' + 'a'.repeat(40), '    bump: ' + 'b'.repeat(40), 'foo-7', '    donesha (latest): 9876fed by beta-2', '    donesha (beta-2): 9876fed', '    status: doing', '    assignee: alpha-1'], 'MUTANT: the named block missing, below the hits, or out of the named order');
  assert.equal(L[9], '    decisions: 3'); assert.equal(L[10], 'bar-9: memory get bar-9'); assert.match(L[11], /^\[1\] /);
  assert.deepEqual(briefBlocks(L), [], 'MUTANT: a brief under a hit');
  assert.doesNotMatch(t, /status: done/, 'MUTANT: the pointed card\'s field lines');
  assert.ok(t.length <= F.COMPACT_MAX_CHARS + F.COMPACT_GET_MAX, `${t.length}`);
  assert.equal(F.formatSearch('foo-7 build', {}, hits, leads, ['nope-1']), F.formatSearch('foo-7 build', {}, hits, leads), 'a named term with no brief changes nothing');
  assert.equal(F.formatSearch('foo-7 build', {}, hits, leads, []), F.formatSearch('foo-7 build', {}, hits, leads));
  assert.equal(F.formatSearch('foo-7 build', {}, hits, leads, ['foo-7'], ['foo-7']), F.formatSearch('foo-7 build', {}, hits, leads, ['foo-7']), 'a named card is never pointed too');
  // M1: EVERY named brief whole, capped by lines alone (no block cap, no demotion to a pointer): the hits give way.
  const big = {}; const named = [];
  for (let i = 1; i <= 8; i++) { big[`card-${i}`] = Array.from({ length: 15 }, (_, j) => `field${j}: ${'v'.repeat(60)}`); named.push(`card-${i}`); }
  const B = lines(F.formatSearch('x', {}, hits, big, named));
  for (let i = 1; i <= 8; i++) {
    const at = 1 + (i - 1) * (1 + F.BRIEF_LINES_MAX);
    assert.equal(B[at], `card-${i}`, `MUTANT: brief ${i} not whole, out of order, or demoted to a pointer`);
    assert.equal(B.slice(at + 1, at + 1 + F.BRIEF_LINES_MAX).filter((l) => /^ {4}field\d+: /.test(l)).length, F.BRIEF_LINES_MAX, `brief ${i} whole, capped by lines`);
  }
  assert.doesNotMatch(B[1 + 8 * (1 + F.BRIEF_LINES_MAX)], /^ {4}field/, 'MUTANT: no line cap');
  assert.ok(!B.some((l) => /^card-\d+: memory get /.test(l)), 'MUTANT: a named brief demoted to a pointer');
  assert.match(B[B.length - 1], /^\[1\] |^… |^keys:|^get:/, 'the hits still follow the block');
  const full = F.formatSearch('foo-7 build', { full: true }, hits, leads, ['foo-7'], ['bar-9']);
  const FL = lines(full);
  const head = FL.indexOf('='.repeat(60), 2);
  assert.deepEqual(FL.slice(head + 2, head + 5), ['  foo-7', '      donesha (latest): 9876fed by beta-2', '      donesha (beta-2): 9876fed'], 'full: the named block after the header');
  assert.equal(FL[head + 8], '  bar-9: memory get bar-9', 'full: the pointer after the briefs');
  assert.doesNotMatch(full, /Card:|status: done/, 'full: no brief under a hit');
  const none = F.formatSearch('foo-7', {}, [], leads, ['foo-7']);
  assert.match(none, /^Results for: "foo-7" — 0 hits, current first \(--full: whole chunks\)\nfoo-7\n {4}donesha \(latest\): 9876fed by beta-2\n {4}donesha \(beta-2\): 9876fed\n/, 'no hits: the named brief still answers');
  assert.doesNotMatch(none, /^get: /m);
  assert.equal(F.formatSearch('foo-7', {}, [], leads, []), F.formatSearch('foo-7', {}, []));
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

test('S3 / S4 engine: the search asks the cardLead dep once with the distinct card ids of its hits in hit order AND the texts (the query first, then each hit\'s content), renders the briefs and the named block; no dep, a throw or a non-object leaves the text as before', async () => {
  const hits = [hit(1, 'live', 'card.foo-7.donesha', '2026-10-02', 'done sha 9876fed'), hit(2, 'live', 'card.foo-7', '2026-10-03', 'build moved'), hit(3, 'live', 'card.bar-9', '2026-10-04', 'bar current'), hit(4, 'live', 'synthetic.port', '2026-10-10', 'port 2222')];
  const calls = [];
  const e = engineWith(hits, async (ask) => { calls.push(ask); return { briefs: LEADS, named: ['bar-9'], pointed: ['foo-7'] }; });
  const r = await e.search({ query: 'foo-7', results: 4 });
  assert.deepEqual(calls, [{ cards: ['foo-7', 'bar-9'], texts: ['foo-7', 'done sha 9876fed', 'build moved', 'bar current', 'port 2222'] }], 'MUTANT: the query or the hit texts not sent');
  assert.match(r.text, /^bar-9\n {4}status: done\nfoo-7: memory get foo-7\n\[1\] /m, 'MUTANT: the named brief or the pointer missing at the top');
  assert.doesNotMatch(r.text, /status: doing/, 'MUTANT: a brief for a card the query does not name');
  assert.equal(briefBlocks(lines(r.text)).filter((b) => b.id === 'bar-9').length, 0);
  const plain = (await engineWith(hits).search({ query: 'foo-7', results: 4 })).text;
  assert.doesNotMatch(plain, /^ {4}foo-7$/m);
  assert.equal((await engineWith(hits, async () => { throw new Error('ledger gone'); }).search({ query: 'foo-7', results: 4 })).text, plain, 'a failing dep: the hits as before');
  assert.equal((await engineWith(hits, async () => null).search({ query: 'foo-7', results: 4 })).text, plain);
  assert.equal((await engineWith(hits, async () => LEADS).search({ query: 'foo-7', results: 4 })).text, plain, 'an old-shape reply (no briefs) is no brief');
  const r2 = await engineWith([hit(4, 'live', 'synthetic.port', '2026-10-10', 'port 2222')], async (ask) => { calls.push(ask); return { briefs: LEADS, named: ['foo-7'] }; }).search({ query: 'port foo-7', results: 1 });
  assert.deepEqual(calls[1], { cards: [], texts: ['port foo-7', 'port 2222'] }, 'MUTANT: no card in the hits, the dep not asked (the query may name one)');
  assert.match(r2.text, /^foo-7\n {4}donesha \(latest\)/m, 'the query-named card\'s brief with no card hit at all');
  const r3 = await engineWith([], async (ask) => { calls.push(ask); return { briefs: LEADS, named: ['foo-7'] }; }).search({ query: 'foo-7', results: 1 });
  assert.match(r3.text, /0 hits, current first \(--full: whole chunks\)\nfoo-7\n {4}donesha/, 'no hits: the named brief still answers');
  const full = await e.search({ query: 'foo-7', results: 4, full: true });
  assert.doesNotMatch(full.text, /Card:/, 'MUTANT: a brief under a hit');
  assert.match(full.text, /^  bar-9\n {6}status: done\n  foo-7: memory get foo-7\n/m, 'MUTANT: the pointer not in the full block');
  const exact = await e.search({ query: 'foo-7', results: 4, exact: true });
  assert.match(exact.text, /^bar-9\n {4}status: done\nfoo-7: memory get foo-7\n/m, 'the --exact path carries the briefs and pointers too');
  const long = engineWith([hit(5, 'live', 'card.foo-7', '2026-10-03', 'x'.repeat(5000))], async (ask) => { calls.push(ask); return { briefs: {}, named: [] }; });
  await long.search({ query: 'q', results: 1 });
  assert.equal(calls[calls.length - 1].texts[1].length, E.LEAD_TEXT_MAX, 'a hit text goes capped');
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
  assert.deepEqual(await lead({ cards: ['foo-7', 'nope-1'], texts: [] }), { briefs: {}, named: [], pointed: ['foo-7', 'nope-1'] }, 'M1: the hits\' cards are pointed, never briefed');
  assert.deepEqual(await lead(['foo-7']), { briefs: {}, named: [], pointed: ['foo-7'] }, 'an old-shape ask (ids only) still answers');
  // S3 / S4 / M1: the query names the release (briefed, named) and a hit names the card (pointed, no brief).
  const ask = await lead({ cards: [], texts: ['the 1.1.98 tag', 'alpha-1 did FOO-7 audit'] });
  assert.deepEqual(ask.named, ['release.1.1.98'], 'MUTANT: a hit-named card briefed as if the query named it');
  assert.deepEqual(ask.pointed, ['foo-7'], 'MUTANT: the hit texts not scanned for the pointers');
  assert.deepEqual((await lead({ cards: ['foo-7'], texts: ['FOO-7 audit', 'alpha-1 did FOO-7 audit'] })).pointed, [], 'a named card is never pointed too');
  assert.deepEqual(ask.briefs['release.1.1.98'], [`tag: ${SHA_T}`, `bump: ${SHA_B}`]);
  assert.equal(ask.briefs['foo-7'], undefined, 'M1: no field lines for a card the query does not name');
  assert.deepEqual((await lead({ cards: [], texts: ['FOO-7 audit by alpha-1'] })).briefs['foo-7'].slice(0, 2), [`donesha (alpha-1): ${SHA_A}`, `audit: PASS ${SHA_T}`], 'the query\'s agent and field lines first');
  assert.deepEqual((await lead({ cards: [], texts: ['guppy/foo-7 tip'] })).named, ['foo-7'], 'a branch owned by the card names it');
  assert.deepEqual(await lead({ cards: [], texts: ['nothing here'] }), { briefs: {}, named: [], pointed: [] });
  assert.deepEqual(await cardLeadsFor(hits, 'q', undefined), { briefs: {}, named: [], pointed: [] }); assert.deepEqual(await cardLeadsFor(hits, 'q', async () => { throw new Error('x'); }), { briefs: {}, named: [], pointed: [] });
  const flags = { results: 4, wing: null, room: null, since: null, before: null, full: false, exact: false, newest: false };
  const tool = await searchTextOver(root, 'foo-7 build', flags, hits);
  const engine = (await engineWith(hits, lead).search({ query: 'foo-7 build', ...flags })).text;
  assert.equal(tool, engine, 'MUTANT: the tool\'s text differs from the engine\'s');
  assert.match(tool, new RegExp(`^foo-7\\n {4}donesha \\(latest\\): ${SHA_B} by beta-2\\n {4}donesha \\(beta-2\\): ${SHA_B}\\n {4}donesha \\(alpha-1\\): ${SHA_A}\\n {4}lastsha: ${SHA_A}\\n {4}status: doing`, 'm'), 'the query names foo-7: its brief at the top, label first, byte for byte get\'s lines');
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
  assert.match(worker, /cardLead: async \(lead\) => \{ const r = await ask\('card-lead', \{ cards: lead\.cards, texts: lead\.texts \}\);/, 'S4: the worker sends the texts with the cards');
  assert.match(worker, /typeof ans\.answer === 'number'/);
  assert.match(worker, /port\.postMessage\(\{ ask: id, op, args \}\)/);
  assert.match(worker, /exact: a\.exact === true, newest: a\.newest === true, kind: \(a\.kind as string\) \?\? null, key: \(a\.key as string\) \?\? null, full: a\.full === true \}/, 'MUTANT: --exact / --newest dropped between service.ts and the engine');
  const wiring = src('src/main/nativeMemory/mainWiring.ts');
  assert.match(wiring, /ask: \(op, args\) => \(op === 'card-lead' && d\.cardLead/);
  const index = src('src/main/index.ts');
  assert.match(index, /cardLead: \(ask\) => \{\s*const root = hive\.root\(\); const ep = claimsEndpoint\(\);/);
  assert.match(wiring, /texts: Array\.isArray\(args\.texts\)/, 'S4: main reads the texts of the ask');
  assert.match(index, /return claimCardLeadOver\(\{ root, store: ep\.store, agents: claimLedgerAgents, tasks:/);
  const service = src('src/main/nativeMemory/service.ts');
  assert.match(service, /if \(q && typeof q\.ask === 'number'\) \{ this\.answer\(/);
});
