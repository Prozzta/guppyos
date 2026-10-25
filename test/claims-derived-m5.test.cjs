'use strict';
/**
 * CLAIMS-90 M5: the deterministic derived claim writers (god 357758, sign-off 104bfd). Facts read
 * from primary records become claims with source 'derived' in the reserved `derived` ledger:
 * (a) answered humanQA, (b) card status/assignee/last sha in git order (guide A11), (c) CHANGELOG
 * entries and release tags, (d) done-mail shas from the card field, subject and body, ranges
 * included (guide A12). Idempotent; a change supersedes the writer's own claim. Fixtures only:
 * synthetic cards, mails and a throwaway git repo; HOME jailed first.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-claims-m5-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
const STORES = [];
test.after(() => {
  for (const s of STORES) s.close();
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const loadTs = require('./load-ts.cjs');
const { ClaimStore } = loadTs('src/main/claims/store.ts');
const { SandboxKeyProvider, FileLedgerKeyRecord, KEY_RECORD_FILE } = loadTs('src/main/claims/keyProvider.ts');
const { derive } = loadTs('src/main/claims/derive.ts');
const { DEFAULT_KEY_REGISTRY, loadRegistry, checkKey } = loadTs('src/main/claims/registry.ts');
const { shouldRunR5 } = loadTs('src/main/claims/reconcile.ts');
const { DERIVED_AGENT_ID, manifestEntry } = loadTs('src/shared/claims.ts');
const F = loadTs('src/main/claims/derivedFacts.ts');
const W = loadTs('src/main/claims/derivedWriter.ts');
const { DerivedGit } = loadTs('src/main/claims/derivedGit.ts');
const { DerivedLive } = loadTs('src/main/claims/derivedLive.ts');
const { discoverSources } = loadTs('src/main/nativeMemory/sources.ts');

const D = DERIVED_AGENT_ID;
let n = 0;
function setup() {
  const root = path.join(JAIL, `hive-${++n}`);
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  const logs = [];
  const keys = new SandboxKeyProvider();
  const store = new ClaimStore({ hiveRoot: root, keys, keyRecord: new FileLedgerKeyRecord(path.join(`${root}-ud`, KEY_RECORD_FILE)), log: (row) => logs.push(row) });
  STORES.push(store);
  const reg = () => { try { return loadRegistry(root); } catch { return DEFAULT_KEY_REGISTRY; } };
  const deps = { store, derive: (records) => derive(records, reg(), { r4: false }), log: (row) => logs.push(row) };
  const read = (a = D) => store.readLedger(a);
  const claims = (a = D) => read(a).records.filter((r) => r.t === 'claim');
  const events = (a = D) => read(a).records.filter((r) => r.t === 'event');
  const live = (a = D) => { const s = deps.derive(read(a).records); return claims(a).filter((c) => s.claims[c.id]?.status === 'live'); };
  return { root, store, keys, deps, read, claims, events, live, logs };
}
const fact = (text, extra = {}) => ({ t: 'claim', kind: 'fact', text, ...extra });

// ———————————————————————————————————————————————————— a throwaway git repo

const GIT_ID = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false'];
function makeRepo() {
  const repo = path.join(JAIL, `repo-${++n}`);
  fs.mkdirSync(repo);
  const g = (args, date) => execFileSync('git', [...GIT_ID, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) } }).trim();
  g(['init', '-q', '-b', 'main']);
  const commit = (msg, date, file = 'f.txt', text = msg) => { fs.writeFileSync(path.join(repo, file), text); g(['add', '-A']); g(['commit', '-q', '-m', msg], date); return g(['rev-parse', 'HEAD']); };
  return { repo, g, commit };
}

// ———————————————————————————————————————————————————— the store gate

test('store: only derived-internal writes the derived ledger, as source derived, claims only', async () => {
  const x = setup();
  const ok = await x.store.appendRecord(D, fact('synthetic derived fact', { key: 'card.syn-1.status' }), 'derived-internal');
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(x.claims()[0].source, 'derived');
  for (const origin of ['endpoint', 'ledger-route', 'ui-ipc', 'w6-internal']) {
    const r = await x.store.appendRecord(D, fact(`from ${origin}`), origin);
    assert.equal(r.ok, false, origin);
    assert.match(r.error, /derived ledger is written by the derived writer only/);
  }
  const elsewhere = await x.store.appendRecord('a1', fact('derived into an agent'), 'derived-internal');
  assert.equal(elsewhere.ok, false);
  assert.match(elsewhere.error, /derived ledger only/);
  const ev = await x.store.appendRecord(D, { t: 'event', ev: 'pin', targets: [ok.id] }, 'derived-internal');
  assert.equal(ev.ok, false);
  assert.match(ev.error, /claims only/);
  const self = await x.store.appendRecord(D, fact('claims to be self', { source: 'self' }), 'derived-internal');
  assert.equal(self.ok, false);
  assert.match(self.error, /source derived only/);
  const agent = await x.store.appendRecord('a1', fact('an agent claims derived', { source: 'derived' }), 'endpoint');
  assert.equal(agent.ok, false, 'an agent token never writes source derived');
  const long = await x.store.appendRecord(D, fact('x'.repeat(401)), 'derived-internal');
  assert.equal(long.ok, false, 'the 400-character limit holds');
  assert.equal(x.claims().length, 1);
  assert.equal(x.read().chain.brokenAt ?? null, null, 'the chain is the store\'s own');
});

test('registry: derived keys skip the near-miss check (release.9.1.1 beside release.9.1.2); agents keep it', () => {
  const reg = structuredClone(DEFAULT_KEY_REGISTRY);
  const at = '2026-10-01T00:00:00.000Z';
  assert.equal(checkKey(reg, 'release.9.1.2', D, at).ok, true);
  assert.deepEqual(checkKey(reg, 'release.9.1.1', D, at), { ok: true, cardinality: 'single', added: true });
  assert.equal(checkKey(reg, 'release.9.1.2.e1', D, at).ok, true);
  assert.equal(checkKey(reg, 'release.9.1.2.e2', D, at).ok, true);
  const agent = checkKey(reg, 'release.9.1.3', 'a1', at);
  assert.equal(agent.ok, false, 'an agent typing a near key is still asked');
  assert.match(agent.error, /did you mean/);
});

test('no export and no reconcile queue for the derived ledger (no memory.md, no one to answer)', async () => {
  const { createClaimExport } = loadTs('src/main/claims/exportWiring.ts');
  const { refreshReconcileQueueForHive } = loadTs('src/main/claims/reconcileHive.ts');
  const touched = [];
  const dir = path.join(JAIL, `export-${++n}`); fs.mkdirSync(dir);
  const ex = createClaimExport({
    level: () => 'writer', agentDir: () => dir, readLedger: (a) => { touched.push(a); return { chain: { ok: true }, records: [] }; },
    registry: () => DEFAULT_KEY_REGISTRY, derive, view: () => ({}), log: () => {}, defer: (fn) => fn(),
  });
  ex.onAppend(D, 'c-000000000001', { t: 'claim' });
  assert.equal(ex.syncAll([D]), 0);
  await ex.drain();
  assert.deepEqual(touched, [], 'the derived ledger is never read for export');
  assert.deepEqual(fs.readdirSync(dir), []);
  ex.syncAll(['a1']);
  assert.deepEqual(touched, ['a1'], 'an agent still is');
  const deps = { endpoint: () => { touched.push('endpoint'); return null; }, queue: () => { throw new Error('no queue'); }, countTokens: () => 1, log: () => {}, registry: () => DEFAULT_KEY_REGISTRY, isOwner: () => true };
  assert.equal(refreshReconcileQueueForHive(dir, D, deps), 0);
  assert.equal(touched.includes('endpoint'), false);
  refreshReconcileQueueForHive(dir, 'a1', deps);
  assert.equal(touched.includes('endpoint'), true);
});

test('derive and R5: a derived claim is protected from mail and never queued for R5', () => {
  const base = { v: 1, t: 'claim', kind: 'fact', agent: D, prev: '', mac: '' };
  const d1 = { ...base, id: 'c-000000000001', at: '2026-10-01T00:00:00.000Z', wt: '2026-10-01T00:00:00.000Z', key: 'release.9.9.9', text: 'derived', source: 'derived' };
  const m1 = { ...base, id: 'c-000000000002', at: '2026-10-02T00:00:00.000Z', wt: '2026-10-02T00:00:00.000Z', key: 'release.9.9.9', text: 'mail says otherwise', source: 'mail:x', supersedes: ['c-000000000001'] };
  const s = derive([d1, m1], DEFAULT_KEY_REGISTRY, { r4: false });
  assert.equal(s.claims[d1.id].status, 'live', 'mail cannot supersede a derived claim (explicitly or by R2)');
  assert.equal(shouldRunR5(d1), false);
  assert.equal(shouldRunR5({ ...d1, source: 'self' }), true);
});

// ———————————————————————————————————————————————————— (a) decisions

test('(a) decisions: answered entries only, the later answer to the same question wins, ids lower-cased', () => {
  const cards = [{
    id: 'SYN-Dec.1', humanQA: [
      { q: 'Ship the synthetic widget?', a: 'No, wait', askedAt: '2026-10-01T08:00:00Z', answeredAt: '2026-10-01T09:00:00Z' },
      { q: 'Unanswered question?' },
      { q: 'Dismissed question?', dismissedAt: '2026-10-01T10:00:00Z' },
      { q: 'Ship  the synthetic   widget?', a: 'Yes, ship it', answeredAt: '2026-10-03T09:00:00Z', msgId: 'm-1' },
      { q: 'Second question?', a: 'Blue', answeredAt: '2026-10-02T09:00:00Z' },
      { q: 'Ship the synthetic widget?', a: 'Older answer, written later on the card', answeredAt: '2026-10-02T00:00:00Z' },
    ],
  }, { id: 'Bad Id With Spaces', humanQA: [{ q: 'q', a: 'a' }] }];
  const out = F.decisionFacts(cards);
  assert.equal(out.length, 2);
  const ship = out.find((f) => f.text.includes('widget'));
  assert.match(ship.key, /^card\.syn-dec\.1\.decision\.[0-9a-f]{8}$/);
  assert.equal(ship.slot, ship.key);
  assert.match(ship.text, /the Human answered "Yes, ship it" \(answered 2026-10-03\)$/);
  assert.equal(ship.at, '2026-10-03T09:00:00.000Z');
  assert.equal(ship.kind, 'decision');
  assert.deepEqual(ship.refs, [{ type: 'task', value: 'SYN-Dec.1' }, { type: 'msg', value: 'm-1' }]);
  const long = F.decisionFacts([{ id: 'SYN-2', humanQA: [{ q: 'q'.repeat(900), a: 'a'.repeat(900), answeredAt: '2026-10-01T00:00:00Z' }] }])[0];
  assert.ok([...long.text].length <= 400, `${[...long.text].length}`);
  const undated = F.decisionFacts([{ id: 'SYN-3', humanQA: [{ q: 'Colour?', a: 'Red' }, { q: 'Colour?', a: 'Green' }] }]);
  assert.equal(undated.length, 1);
  assert.match(undated[0].text, /answered "Green"$/, 'no dates: the later entry on the card wins');
  assert.equal(undated[0].at, undefined);
  assert.match(long.text, /answered 2026-10-01/);
});

// ———————————————————————————————————————————————————— shas and git order

test('sha mentions: 7-40 hex with a digit and a letter, ranges give both ends, no dates or words', () => {
  const m = F.shaMentions('fixed in 1a2b3c4d, range 0abc1234..9def5678 and abcd123...123abcd; date 20261024; word defaced; long 0123456789abcdef0123456789abcdef01234567; x1a2b3c4dz; uid9f8e7d6c5; 1a2b3c4d again');
  assert.deepEqual(m.map((x) => x.sha), ['1a2b3c4d', '0abc1234', '9def5678', 'abcd123', '123abcd', '0123456789abcdef0123456789abcdef01234567']);
  assert.deepEqual(m[1].range, { from: '0abc1234', to: '9def5678', end: 'from' });
  assert.equal(m[2].range.end, 'to');
  assert.equal(m[3].range.to, '123abcd', 'a...b counts as a range too');
  assert.deepEqual(F.shaMentions(null), []);
});

function fakeGit(spec) {
  // spec: { commits: {short: full}, parents: {full: [full]}, time: {full: n}, tags: Set(short) }
  const anc = (a, b) => { const seen = new Set(); const st = [b]; while (st.length) { const c = st.pop(); if (c === a) return true; if (seen.has(c)) continue; seen.add(c); st.push(...(spec.parents[c] ?? [])); } return false; };
  return {
    calls: 0,
    async commitOf(s) { this.calls++; return spec.commits[s] ?? null; },
    async isAncestor(a, b) { return a !== b && anc(a, b); },
    async time(c) { return spec.time[c] ?? 0; },
  };
}
const H = (c) => c.repeat(40);

test('A11: a descendant beats its ancestor even when older; unrelated lines go by time, then sha; tag objects never count', async () => {
  const g = fakeGit({
    commits: { aaaaaa1: H('a'), bbbbbb2: H('b'), cccccc3: H('c'), dddddd4: H('d') },
    parents: { [H('b')]: [H('a')], [H('c')]: [H('a')] },
    time: { [H('a')]: 100, [H('b')]: 50, [H('c')]: 300, [H('d')]: 200 },
  });
  assert.equal(await F.latestInGitOrder(['aaaaaa1', 'bbbbbb2'], g), H('b'), 'the descendant, though its time is earlier');
  assert.equal(await F.latestInGitOrder(['bbbbbb2', 'aaaaaa1'], g), H('b'), 'order does not matter');
  assert.equal(await F.latestInGitOrder(['bbbbbb2', 'dddddd4'], g), H('d'), 'unrelated: the later time');
  assert.equal(await F.latestInGitOrder(['aaaaaa1', 'bbbbbb2', 'cccccc3', 'dddddd4'], g), H('c'));
  assert.equal(await F.latestInGitOrder(['eeeeee5'], g), null, 'a tag object or missing object is no candidate');
  const tie = fakeGit({ commits: { aaaaaa1: H('a'), bbbbbb2: H('b') }, parents: {}, time: { [H('a')]: 5, [H('b')]: 5 } });
  assert.equal(await F.latestInGitOrder(['bbbbbb2', 'aaaaaa1'], tie), H('b'));
  assert.equal(await F.latestInGitOrder(['aaaaaa1', 'bbbbbb2'], tie), H('b'));
});

// ———————————————————————————————————————————————————— (b) card fields

test('(b) card fields: status, assignee (or none), last sha only with git and only from commits', async () => {
  const g = fakeGit({ commits: { aaaaaa1: H('a'), bbbbbb2: H('b') }, parents: { [H('b')]: [H('a')] }, time: {} });
  const cards = [
    { id: 'SYN-B1', title: 'A synthetic card', status: 'done', assignee: 'agent-x', result: 'shipped aaaaaa1', notes: 'then bbbbbb2 and 20261024' },
    { id: 'SYN-B2', status: 'todo', result: 'nothing here 1234567' },
  ];
  const out = await F.cardFieldFacts(cards, g);
  const by = Object.fromEntries(out.map((f) => [f.slot, f]));
  assert.equal(by['card.syn-b1.status'].text, 'Card SYN-B1 ("A synthetic card") status: done');
  assert.equal(by['card.syn-b1.assignee'].text, 'Card SYN-B1 ("A synthetic card") is assigned to agent-x');
  assert.equal(by['card.syn-b2.assignee'].text, 'Card SYN-B2 has no assignee');
  assert.match(by['card.syn-b1.lastsha'].text, new RegExp(`last commit .*: bbbbbbbb \\(${H('b')}\\)$`));
  assert.deepEqual(by['card.syn-b1.lastsha'].refs, [{ type: 'task', value: 'SYN-B1' }, { type: 'commit', value: H('b') }]);
  assert.equal(by['card.syn-b2.lastsha'], undefined, 'a hex word that is no commit gives no last sha');
  assert.equal((await F.cardFieldFacts(cards, null)).some((f) => f.key.endsWith('.lastsha')), false, 'no git, no last sha');
});

// ———————————————————————————————————————————————————— (c) releases

const CHANGELOG = [
  '# Changelog', '', '## [Unreleased]', '', '- **Work in progress.** Not released.', '',
  '## [9.1.2] — 2026-10-24', '', '**Synthetic headline for nine one two.**', 'Rollback: 9.1.1.', '',
  '### Changed', '', '- **The widget is faster.** It was slow', '  and now it is not.', '- **Second change.** Detail.', '',
  '### Fixed', '', '- **A crash on start.** Gone.', '',
  '## [9.1.1] — 2026-10-20', '', '### Added', '', '- **First entry.** Text.', '',
].join('\n');

test('(c) releases: CHANGELOG sections and entries (Unreleased skipped), the tag\'s commit, keys release.<ver>[.e<n>]', () => {
  const secs = F.parseChangelog(CHANGELOG);
  assert.deepEqual(secs.map((s) => s.version), ['9.1.2', '9.1.1']);
  assert.equal(secs[0].headline, '**Synthetic headline for nine one two.**');
  assert.deepEqual(secs[0].entries.map((e) => e.heading), ['Changed', 'Changed', 'Fixed']);
  assert.equal(secs[0].entries[0].text, '**The widget is faster.** It was slow and now it is not.');
  const out = F.releaseFacts(secs, [{ name: 'v9.1.2', commit: H('c'), date: '2026-10-24T10:00:00+02:00' }, { name: 'v9.0.0', commit: H('d') }, { name: 'not-a-version', commit: H('e') }]);
  const by = Object.fromEntries(out.map((f) => [f.key, f]));
  assert.match(by['release.9.1.2'].text, new RegExp(`^Guppy 9\\.1\\.2, released 2026-10-24 \\(CHANGELOG\\), tag v9\\.1\\.2 is commit ${H('c')} \\(tagged 2026-10-24\\)\\. \\*\\*Synthetic headline`));
  assert.equal(by['release.9.1.2'].at, '2026-10-24T08:00:00.000Z');
  assert.deepEqual(by['release.9.1.2'].refs, [{ type: 'commit', value: H('c') }]);
  assert.equal(by['release.9.1.2.e1'].text, 'Guppy 9.1.2 (2026-10-24) CHANGELOG Changed: **The widget is faster.** It was slow and now it is not.');
  assert.equal(by['release.9.1.2.e3'].text, 'Guppy 9.1.2 (2026-10-24) CHANGELOG Fixed: **A crash on start.** Gone.');
  assert.equal(by['release.9.0.0'].text, `Guppy 9.0.0, tag v9.0.0 is commit ${H('d')}`, 'a tag with no section still gives its release');
  assert.equal(by['release.9.1.1'].refs.length, 0);
  assert.equal(Object.keys(by).some((k) => /unreleased|not-a-version/i.test(k)), false);
  for (const f of out) assert.ok([...f.text].length <= 400);
});

// ———————————————————————————————————————————————————— (d) done mails

test('A12 card match: dash, space or nothing; case-insensitive; the longest id; no partial ids', () => {
  const m = F.cardMatcher(['INT-1.1.98', 'CLAIMS-90', 'CLAIMS-90-M5', 'X']);
  assert.deepEqual(m('INT 1.1.98 done'), ['INT-1.1.98']);
  assert.deepEqual(m('int1.1.98 done'), ['INT-1.1.98']);
  assert.deepEqual(m('see claims-90-m5 now'), ['CLAIMS-90-M5']);
  assert.deepEqual(m('CLAIMS-90: and CLAIMS 90'), ['CLAIMS-90']);
  assert.deepEqual(m('INT-1.1.981 or INT-1.1.98.1 or XINT-1.1.98 or CLAIMS-901'), []);
  assert.deepEqual(m('a X b'), [], 'a one-letter id never matches');
  assert.deepEqual(m('CLAIMS 90 M5 landed'), ['CLAIMS-90-M5'], 'the longest id, written with spaces');
});

test('(d) done mails: card field, else subject, else body; shas that are commits, ranges both ends; one per (card, commit)', async () => {
  const g = fakeGit({ commits: { aaaaaa1: H('a'), bbbbbb2: H('b'), cccccc3: H('c'), dddddd4: H('d') }, parents: {}, time: {} });
  const mails = [
    { id: 'm1', act: 'done', from: 'agent-x', card: 'SYN-D1', subject: 'SYN-D2 aaaaaa1', body: 'also bbbbbb2', created_at: '2026-10-02T00:00:00Z' },
    { id: 'm1', act: 'done', card: 'SYN-D1', subject: 'a second copy of m1', body: 'cccccc3' },
    { id: 'm2', act: 'done', from: 'agent-y', subject: 'SYN D2 shipped', body: 'range aaaaaa1..dddddd4, 1234567 is no sha and fedcba9 no commit', created_at: '2026-10-03T00:00:00Z' },
    { id: 'm3', act: 'done', subject: 'no card here', body: 'SYN-D3 at cccccc3' },
    { id: 'm4', act: 'done', subject: 'SYN-D1 and SYN-D2', body: 'dddddd4' },
    { id: 'm5', act: 'inform', subject: 'SYN-D1', body: 'dddddd4' },
    { id: 'm6', act: 'done', subject: 'SYN-D1 nothing', body: 'no shas' },
    { id: 'm7', act: 'done', card: 'SYN-D1', subject: 'again', body: 'aaaaaa1', created_at: '2026-10-01T00:00:00Z' },
    { id: 'm8', act: 'done', subject: 'SYN-D3 follow-up', body: 'like SYN-D1 at bbbbbb2' },
  ];
  const r = await F.doneMailFacts(mails, ['SYN-D1', 'SYN-D2', 'SYN-D3'], g);
  const slots = r.facts.map((f) => f.slot).sort();
  assert.deepEqual(slots, [
    `card.syn-d1.donesha#${H('a')}`, `card.syn-d1.donesha#${H('b')}`,
    `card.syn-d2.donesha#${H('a')}`, `card.syn-d2.donesha#${H('d')}`,
    `card.syn-d3.donesha#${H('b')}`, `card.syn-d3.donesha#${H('c')}`,
  ]);
  assert.equal(r.facts.some((f) => f.refs.some((y) => y.type === 'commit' && y.value.startsWith('fedcba9'))), false, 'a hex word git does not know is no commit');
  assert.deepEqual(r.skipped, { notDone: 1, noCard: 0, ambiguous: 1, noCommit: 1 });
  const d1a = r.facts.find((f) => f.slot === `card.syn-d1.donesha#${H('a')}`);
  assert.match(d1a.text, /done mail m7 from unknown names commit aaaaaaaa/, 'the earliest mail that named it');
  const d2d = r.facts.find((f) => f.slot === `card.syn-d2.donesha#${H('d')}`);
  assert.match(d2d.text, /\(the end of the range aaaaaa1\.\.dddddd4\)$/);
  assert.deepEqual(d2d.refs, [{ type: 'task', value: 'SYN-D2' }, { type: 'msg', value: 'm2' }, { type: 'commit', value: H('d') }]);
  assert.equal(d2d.at, '2026-10-03T00:00:00.000Z');
});

// ———————————————————————————————————————————————————— the writer

test('writer: idempotent (no claim and no sighting on a re-run), a change supersedes its own claim, slots stay apart', async () => {
  const x = setup();
  const f1 = [
    { slot: 'card.syn-w.status', key: 'card.syn-w.status', kind: 'fact', text: 'Card SYN-W status: doing', refs: [{ type: 'task', value: 'SYN-W' }] },
    { slot: `card.syn-w.donesha#${H('a')}`, key: 'card.syn-w.donesha', kind: 'fact', text: 'sha a', refs: [{ type: 'commit', value: H('a') }] },
    { slot: `card.syn-w.donesha#${H('b')}`, key: 'card.syn-w.donesha', kind: 'fact', text: 'sha b', refs: [{ type: 'commit', value: H('b') }] },
  ];
  assert.deepEqual(await W.syncDerived(x.deps, f1), { facts: 3, appended: 3, unchanged: 0, superseded: 0, failed: 0 });
  assert.deepEqual(await W.syncDerived(x.deps, f1), { facts: 3, appended: 0, unchanged: 3, superseded: 0, failed: 0 });
  assert.equal(x.events().length, 0, 'no R1 sighting events');
  const first = x.claims()[0].id;
  const f2 = [{ ...f1[0], text: 'Card SYN-W status: done' }, f1[1], f1[2]];
  assert.deepEqual(await W.syncDerived(x.deps, f2), { facts: 3, appended: 1, unchanged: 2, superseded: 1, failed: 0 });
  const live = x.live();
  assert.equal(live.length, 3);
  const st = live.find((c) => c.key === 'card.syn-w.status');
  assert.equal(st.text, 'Card SYN-W status: done');
  assert.deepEqual(st.supersedes, [first]);
  assert.equal(st.supersedesReason.category, 'changed');
  // Back to the earlier value: a new claim (the old one is superseded, not live), not a sighting.
  assert.equal((await W.syncDerived(x.deps, f1)).appended, 1);
  assert.equal(x.events().length, 0);
  assert.equal(x.live().find((c) => c.key === 'card.syn-w.status').text, 'Card SYN-W status: doing');
  // A refs change alone is a change.
  assert.equal((await W.syncDerived(x.deps, [{ ...f1[0], refs: [{ type: 'task', value: 'SYN-W' }, { type: 'msg', value: 'm9' }] }])).appended, 1);
  // A refused append is counted and logged, never thrown.
  const bad = await W.syncDerived(x.deps, [{ slot: 'card.syn-w.x', key: 'card.syn-w.x', kind: 'fact', text: 'y'.repeat(401), refs: [] }]);
  assert.equal(bad.failed, 1);
  assert.ok(x.logs.some((r) => r.kind === 'claims-derived-append-failed'));
  assert.ok(x.claims().every((c) => c.source === 'derived'));
});

test('writer: another source\'s claim in the slot is never superseded or counted', () => {
  assert.equal(W.slotOf({ key: 'card.a.donesha', refs: [{ type: 'commit', value: H('a') }] }), `card.a.donesha#${H('a')}`);
  assert.equal(W.slotOf({ key: 'card.a.donesha' }), null);
  assert.equal(W.slotOf({ key: 'card.a.status' }), 'card.a.status');
  assert.equal(W.slotOf({}), null);
});

// ———————————————————————————————————————————————————— the backfill over a fixture hive + repo

function fixtureHive(x, r) {
  const a = r.commit('first', '2026-10-01T10:00:00Z');
  r.g(['checkout', '-q', '-b', 'side']);
  const side = r.commit('side line', '2026-10-05T10:00:00Z', 's.txt');
  r.g(['checkout', '-q', 'main']);
  const b = r.commit('second', '2026-10-02T10:00:00Z');
  fs.writeFileSync(path.join(r.repo, 'CHANGELOG.md'), CHANGELOG);
  const c = r.commit('release', '2026-10-03T10:00:00Z');
  r.g(['tag', '-a', 'v9.1.2', '-m', 'release 9.1.2'], '2026-10-03T11:00:00Z');
  const tagObj = r.g(['rev-parse', 'v9.1.2']);
  const tasks = { tasks: [
    { id: 'SYN-H1', title: 'Hot card', status: 'done', assignee: 'agent-x', dependsOn: [], priority: 1, createdAt: '2026-10-01T00:00:00Z',
      result: `first ${a.slice(0, 8)} then ${b.slice(0, 10)}; tag object ${tagObj.slice(0, 8)}`, notes: `side ${side.slice(0, 7)}`,
      humanQA: [{ q: 'Synthetic go?', a: 'Go', answeredAt: '2026-10-02T00:00:00Z' }] },
    { id: 'SYN-H2', title: 'Second', status: 'todo', dependsOn: [], priority: 1, createdAt: '2026-10-01T00:00:00Z' },
  ] };
  fs.writeFileSync(path.join(x.root, 'tasks.json'), JSON.stringify(tasks));
  fs.mkdirSync(path.join(x.root, 'tasks-archive'));
  fs.writeFileSync(path.join(x.root, 'tasks-archive', '2026-10.jsonl'), `${JSON.stringify({ card: { id: 'SYN-A1', title: 'Archived', status: 'done', result: `done at ${c.slice(0, 8)}` } })}\n`);
  for (const ag of ['agent-x', 'agent-y']) fs.mkdirSync(path.join(x.root, 'agents', ag, 'inbox', '.done'), { recursive: true });
  const mail = { id: 'm-h1', act: 'done', from: 'agent-x', to: 'god', subject: 'SYN H2 shipped', body: `range ${a.slice(0, 8)}..${c.slice(0, 8)}`, created_at: '2026-10-03T12:00:00Z' };
  fs.writeFileSync(path.join(x.root, 'agents', 'agent-x', 'inbox', '.done', 'm-h1.json'), JSON.stringify(mail));
  fs.writeFileSync(path.join(x.root, 'agents', 'agent-y', 'inbox', 'm-h1.json'), JSON.stringify(mail));
  fs.writeFileSync(path.join(x.root, 'agents', 'agent-y', 'inbox', 'm-h2.json'), JSON.stringify({ id: 'm-h2', act: 'request', subject: 'SYN-H1', body: b }));
  return { a, b, c, side, tagObj };
}

test('backfill: a fixture hive and repo give every kind once; a re-run appends nothing; the derived ledger only', async () => {
  const x = setup();
  const r = makeRepo();
  const s = fixtureHive(x, r);
  const git = new DerivedGit(r.repo);
  assert.equal(await git.ok(), true);
  const tags = await git.tags();
  assert.deepEqual(tags.map((t) => [t.name, t.commit]), [['v9.1.2', s.c]], 'the annotated tag is peeled to its commit');
  assert.equal(await new DerivedGit(r.repo).commitOf(s.tagObj.slice(0, 8)), null, 'a tag object is not a commit');
  assert.equal(await git.commitOf(s.c.slice(0, 8)), s.c);
  assert.equal(await git.commitOf('fedcba9'), null);
  const input = { hiveRoot: x.root, git, releases: { changelog: await git.show('v9.1.2', 'CHANGELOG.md'), tags }, prefetch: (shas) => git.prefetch(shas) };
  const c1 = await W.runDerivedBackfill(x.deps, input);
  assert.equal(c1.cards, 3, 'hot cards plus the archived one');
  assert.equal(c1.doneMails, 2, 'both copies are read; they fold by id');
  assert.equal(c1.decisions.appended, 1);
  assert.equal(c1.cardFields.appended, 3 + 2 + 3, 'SYN-H1 and SYN-A1 status/assignee/lastsha, SYN-H2 status/assignee (no commit named)');
  const live = Object.fromEntries(x.live().filter((c) => !c.key.endsWith('.donesha')).map((c) => [c.key, c]));
  assert.match(live['card.syn-h1.lastsha'].text, new RegExp(`${s.side}\\)$`), 'unrelated lines: the side commit is later by time');
  assert.match(live['card.syn-a1.lastsha'].text, new RegExp(`${s.c}\\)$`), 'archived cards count');
  assert.equal(c1.releases.appended, 1 + 3 + 1 + 1, 'release.9.1.2 + 3 entries, release.9.1.1 + 1 entry');
  assert.match(live['release.9.1.2'].text, new RegExp(`tag v9\\.1\\.2 is commit ${s.c}`));
  const done = x.live().filter((c) => c.key === 'card.syn-h2.donesha').map((c) => c.refs.find((y) => y.type === 'commit').value).sort();
  assert.deepEqual(done, [s.a, s.c].sort(), 'both range ends, once each');
  assert.equal(c1.doneShas.appended, 2);
  assert.equal(c1.decisions.failed + c1.cardFields.failed + c1.releases.failed + c1.doneShas.failed, 0);
  const c2 = await W.runDerivedBackfill(x.deps, input);
  for (const k of ['decisions', 'cardFields', 'releases', 'doneShas']) assert.equal(c2[k].appended, 0, k);
  assert.equal(x.events().length, 0);
  assert.deepEqual(fs.readdirSync(path.join(x.root, 'agents')).sort(), ['agent-x', 'agent-y', 'derived']);
  assert.deepEqual(fs.readdirSync(path.join(x.root, 'agents', 'derived')), ['memory']);
  assert.deepEqual(fs.readdirSync(path.join(x.root, 'agents', 'derived', 'memory')), ['claims']);
  assert.equal(x.read().chain.brokenAt ?? null, null);
  // No repo: decisions, status, assignee and releases from the CHANGELOG; nothing that needs git.
  const y = setup();
  fixtureHive(y, makeRepo());
  const c3 = await W.runDerivedBackfill(y.deps, { hiveRoot: y.root, git: null, releases: { changelog: CHANGELOG, tags: [] } });
  assert.equal(c3.doneMails, 0);
  assert.equal(y.live().some((c) => /\.(lastsha|donesha)$/.test(c.key)), false);
  assert.equal(c3.releases.appended, 6);
});

test('backfill CLI: runs on a hive copy with the key on stdin, refuses the live hive', async () => {
  const x = setup();
  const r = makeRepo();
  fixtureHive(x, r);
  // The store makes its key at the first append; the CLI gets it as hex, as the runner passes it.
  await x.store.appendRecord(D, fact('seed', { key: 'card.seed.status' }), 'derived-internal');
  x.store.close();
  const key = Buffer.from(x.keys.load().key).toString('hex');
  const cli = path.join(__dirname, '..', 'scripts', 'claims-derived-backfill.cjs');
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { input: `${key}\n`, encoding: 'utf8', env: { ...process.env, MUNDER_HIVE_ROOT: path.join(JAIL, 'live-hive') }, timeout: 120_000 });
  const ok = run(['--hive', x.root, '--user-data', `${x.root}-ud`, '--repo', r.repo, '--now', '2026-10-04T00:00:00Z']);
  assert.equal(ok.status, 0, `${ok.stderr}${ok.stdout}`);
  const out = JSON.parse(ok.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.tags, 1);
  assert.equal(out.changelog, true);
  assert.equal(out.doneShas.appended, 2);
  const again = JSON.parse(run(['--hive', x.root, '--user-data', `${x.root}-ud`, '--repo', r.repo, '--now', '2026-10-04T00:00:00Z']).stdout);
  assert.equal(again.decisions.appended + again.cardFields.appended + again.releases.appended + again.doneShas.appended, 0, 'idempotent across processes');
  const wt = x.store.readLedger(D).records.filter((c) => c.text !== 'seed').map((c) => c.wt);
  assert.ok(wt.length > 0 && wt.every((w) => w === '2026-10-04T00:00:00.000Z'), '--now is the store clock');
  const live = run(['--hive', path.join(JAIL, 'live-hive', 'sub'), '--user-data', `${x.root}-ud`]);
  assert.equal(live.status, 2);
  assert.match(live.stderr, /never the live hive/);
  const nokey = spawnSync(process.execPath, [cli, '--hive', x.root, '--user-data', `${x.root}-ud`], { input: 'nope', encoding: 'utf8', env: { ...process.env, MUNDER_HIVE_ROOT: path.join(JAIL, 'live-hive') } });
  assert.equal(nokey.status, 2);
});

// ———————————————————————————————————————————————————— live driver and search

test('live driver: waits while disabled, serializes runs, reads only new done-mail files', async () => {
  const x = setup();
  const r = makeRepo();
  fixtureHive(x, r);
  let enabled = false;
  const timers = [];
  const live = new DerivedLive({
    hiveRoot: () => x.root, writer: () => x.deps, enabled: () => enabled, repo: () => r.repo, changelog: () => CHANGELOG, log: (row) => x.logs.push(row),
    setTimeout: (fn) => { timers.push(fn); return { unref() {} }; }, setInterval: (fn) => { timers.push(fn); return { unref() {} }; },
  });
  live.start();
  live.start();
  assert.equal(timers.length, 2, 'start is once per run');
  await live.run('start', () => live.full());
  assert.equal(x.claims().length, 0, 'disabled: nothing is written');
  enabled = true;
  await live.run('start', () => live.full());
  const n1 = x.claims().length;
  assert.ok(n1 > 0);
  // A new done mail lands; the pass reads it (and nothing old again).
  fs.writeFileSync(path.join(x.root, 'agents', 'agent-x', 'inbox', 'm-h3.json'), JSON.stringify({ id: 'm-h3', act: 'done', card: 'SYN-H1', subject: 'x', body: r.g(['rev-parse', 'HEAD~1']) }));
  await live.run('pass', () => live.pass());
  assert.equal(x.claims().length, n1 + 1);
  await live.run('pass', () => live.pass());
  assert.equal(x.claims().length, n1 + 1, 'a second pass writes nothing');
  // A file already seen is not read again (a pass reads only new inbox files; the start backfill reads all).
  fs.writeFileSync(path.join(x.root, 'agents', 'agent-x', 'inbox', 'm-h3.json'), JSON.stringify({ id: 'm-h3', act: 'done', card: 'SYN-H1', subject: 'x', body: r.g(['rev-parse', 'HEAD~2']) }));
  await live.run('pass', () => live.pass());
  assert.equal(x.claims().length, n1 + 1, 'the seen file is not re-read');
  live.cardsChanged();
  assert.equal(timers.length, 3, 'the card change is debounced through a timer');
  assert.ok(!x.logs.some((row) => row.kind === 'claims-derived-failed'), JSON.stringify(x.logs.filter((row) => row.kind === 'claims-derived-failed')));
});

test('search: the derived ledger is a claims source once it has segments (it has no import to settle)', async () => {
  const x = setup();
  await x.store.appendRecord(D, fact('a derived fact', { key: 'card.syn-s.status' }), 'derived-internal');
  fs.mkdirSync(path.join(x.root, 'agents', 'a1', 'memory', 'claims'), { recursive: true });
  fs.writeFileSync(path.join(x.root, 'agents', 'a1', 'memory', 'claims', '2026-10.jsonl'), '');
  // The manifest names a1 (agents are opted in one by one); derived has no hire to add its entry.
  fs.writeFileSync(path.join(x.root, 'memory-sources.json'), JSON.stringify({ topLevel: [], include: {}, ledger: { a1: 'writer' } }));
  const wings = (level) => discoverSources(x.root, undefined, { claimLedger: level, implemented: 'writer' }).eligible.filter((e) => e.kind === 'claims').map((e) => e.wing);
  assert.deepEqual(wings('reader'), ['derived'], 'derived with no manifest entry and no settled marker; a1 still needs its import settled');
  fs.writeFileSync(path.join(x.root, 'agents', 'a1', 'memory', 'claims-import.json'), '{}');
  assert.deepEqual(wings('reader'), ['a1', 'derived']);
  assert.deepEqual(wings('off'), [], 'the Settings level still rules');
  fs.writeFileSync(path.join(x.root, 'memory-sources.json'), JSON.stringify({ topLevel: [], include: {}, ledger: { a1: 'writer', derived: 'off' } }));
  assert.deepEqual(wings('reader'), ['a1'], 'a written entry narrows derived like any agent');
  assert.equal(manifestEntry(undefined, D), 'writer');
  assert.equal(manifestEntry({}, 'a1'), undefined, 'an agent with no entry stays off');
  assert.equal(manifestEntry({ derived: 'shadow' }, D), 'shadow');
});
