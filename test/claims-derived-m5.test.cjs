'use strict';
/**
 * CLAIMS-90 M5: the deterministic derived claim writers (god 357758, sign-off 104bfd). Facts read
 * from primary records become claims with source 'derived' in the reserved `derived` ledger:
 * (a) answered humanQA, (b) card status/assignee/last sha in git order (guide A11), (c) CHANGELOG
 * entries and release tags, (d) done-mail shas from the card field, subject and body, ranges
 * included (guide A12). Idempotent; a change supersedes the writer's own claim. R2: one done-sha
 * claim per (card, sender), decisions never clipped, the mail-cards index, git history. Fixtures only:
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
const { SandboxKeyProvider, FileLedgerKeyRecord, KEY_RECORD_FILE, hiveIdOf } = loadTs('src/main/claims/keyProvider.ts');
const { derive } = loadTs('src/main/claims/derive.ts');
const { DEFAULT_KEY_REGISTRY, loadRegistry, checkKey } = loadTs('src/main/claims/registry.ts');
const { shouldRunR5 } = loadTs('src/main/claims/reconcile.ts');
const { DERIVED_AGENT_ID, manifestEntry } = loadTs('src/shared/claims.ts');
const F = loadTs('src/main/claims/derivedFacts.ts');
const W = loadTs('src/main/claims/derivedWriter.ts');
const { DerivedGit, GIT_TIMEOUT_MS } = loadTs('src/main/claims/derivedGit.ts');
const { mailBodyHash } = loadTs('src/main/mailLedger.ts');
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
  assert.equal(ship.text, 'Human decision on SYN-Dec.1: the Human answered "Yes, ship it" on 2026-10-03 to the question "Ship the synthetic widget?"');
  assert.equal(ship.at, '2026-10-03T09:00:00.000Z');
  assert.equal(ship.kind, 'decision');
  assert.deepEqual(ship.refs, [{ type: 'task', value: 'SYN-Dec.1' }, { type: 'msg', value: 'm-1' }]);
  // R2 (e): never clipped: a long decision goes on in .p2, .p3, ... (each claim within 400 characters).
  const qLong = Array.from({ length: 150 }, (_, i) => `q${i}`).join(' ');
  const aLong = Array.from({ length: 150 }, (_, i) => `a${i}`).join(' ');
  const parts = F.decisionFacts([{ id: 'SYN-2', humanQA: [{ q: qLong, a: aLong, answeredAt: '2026-10-01T00:00:00Z' }] }]);
  assert.ok(parts.length >= 3, `${parts.length}`);
  assert.ok(parts.every((p) => [...p.text].length <= 400), parts.map((p) => [...p.text].length).join());
  assert.match(parts[0].key, /^card\.syn-2\.decision\.[0-9a-f]{8}$/);
  parts.slice(1).forEach((p, i) => assert.equal(p.key, `${parts[0].key}.p${i + 2}`));
  parts.forEach((p, i) => assert.ok(p.text.startsWith(`Human decision on SYN-2 (part ${i + 1} of ${parts.length}): `), p.text.slice(0, 50)));
  const whole = parts.map((p) => p.text.replace(/^Human decision on SYN-2 \(part \d+ of \d+\): /, '')).join(' ');
  assert.equal(whole, `the Human answered "${aLong}" on 2026-10-01 to the question "${qLong}"`, 'every word of the answer and the question, in order');
  assert.ok(parts[0].text.includes('the Human answered "a0 a1'), 'the answer comes first');
  const long = parts[0];
  // No room in the key grammar for parts: one clipped claim, as before.
  const deep = F.decisionFacts([{ id: 'S.Y.N.4.5', humanQA: [{ q: qLong, a: aLong }] }]);
  assert.equal(deep.length, 1);
  assert.ok([...deep[0].text].length <= 400 && deep[0].text.endsWith('…'));
  const undated = F.decisionFacts([{ id: 'SYN-3', humanQA: [{ q: 'Colour?', a: 'Red' }, { q: 'Colour?', a: 'Green' }] }]);
  assert.equal(undated.length, 1);
  assert.match(undated[0].text, /answered "Green" to the question "Colour\?"$/, 'no dates: the later entry on the card wins');
  assert.equal(undated[0].at, undefined);
  assert.match(whole, / on 2026-10-01 to the question /);
  assert.equal(long.at, '2026-10-01T00:00:00.000Z');
});

// ———————————————————————————————————————————————————— shas and git order

test('sha mentions: 7-40 hex with a digit and a letter, ranges give both ends, no dates or words', () => {
  const m = F.shaMentions('fixed in 1a2b3c4d, range 0abc1234..9def5678 and abcd123...123abcd; date 20261024; word defaced; long 0123456789abcdef0123456789abcdef01234567; x1a2b3c4dz; uid9f8e7d6c5; 1a2b3c4d again');
  assert.deepEqual(m.map((x) => x.sha), ['1a2b3c4d', '0abc1234', '9def5678', 'abcd123', '123abcd', '0123456789abcdef0123456789abcdef01234567']);
  assert.deepEqual(m[1].range, { from: '0abc1234', to: '9def5678', end: 'from' });
  assert.equal(m[2].range.end, 'to');
  assert.equal(m[3].range.to, '123abcd', 'a...b counts as a range too');
  assert.deepEqual(F.shaMentions(null), []);
  // Digit-only shas (Jim a6ae9d F2): written @<sha>, or 8+ digits that are not a date; git decides the rest.
  assert.deepEqual(F.shaMentions('head @58102304 and @1234567, size 94861030, date 20261024, count 5948').map((x) => x.sha), ['58102304', '1234567', '94861030']);
});

function fakeGit(spec) {
  // spec: { commits: {short: full}, parents: {full: [full]}, time: {full: n}, tags: Set(short) }
  const anc = (a, b) => { const seen = new Set(); const st = [b]; while (st.length) { const c = st.pop(); if (c === a) return true; if (seen.has(c)) continue; seen.add(c); st.push(...(spec.parents[c] ?? [])); } return false; };
  return {
    calls: 0,
    async commitOf(s) { this.calls++; return spec.commits[s] ?? null; },
    async isAncestor(a, b) { return a !== b && anc(a, b); },
    async time(c) { return spec.time[c] ?? 0; },
    ...(spec.messages ? { async message(c) { return spec.messages[c] ?? null; } } : {}),
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
  assert.match(by['release.9.1.2'].text, new RegExp(`^Guppy 9\\.1\\.2, released 2026-10-24 \\(CHANGELOG\\), tag v9\\.1\\.2 is commit ${H('c')} \\(tagged 2026-10-24\\)\\. Synthetic headline for nine one two\\.$`), 'stored without markup');
  assert.equal(by['release.9.1.2'].at, '2026-10-24T08:00:00.000Z');
  assert.deepEqual(by['release.9.1.2'].refs, [{ type: 'commit', value: H('c') }]);
  assert.equal(by['release.9.1.2.e1'].text, 'Guppy 9.1.2 (2026-10-24) CHANGELOG Changed: The widget is faster. It was slow and now it is not.', 'stored without markup');
  assert.equal(by['release.9.1.2.e3'].text, 'Guppy 9.1.2 (2026-10-24) CHANGELOG Fixed: A crash on start. Gone.');
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

test('(d) done mails, R2 (a)(c): one per (card, sender): the newest done mail and the latest of its commits; every skip has a reason', async () => {
  // CLAIMS-WEAKLINK-DONESHA round 2: a card named in a subject (no card field) needs a commit SUBJECT
  // naming it, like a body-named one. a is a shared commit of SYN-D1 and SYN-D2; b is SYN-D3's; c and d name no card.
  const g = fakeGit({ commits: { aaaaaa1: H('a'), bbbbbb2: H('b'), cccccc3: H('c'), dddddd4: H('d') }, parents: {}, time: {},
    messages: { [H('a')]: 'SYN-D1 and SYN-D2: the shared step', [H('b')]: 'SYN-D3: follow-up', [H('c')]: 'later work\n\nSYN-D3 in the body only', [H('d')]: 'housekeeping' } });
  const mails = [
    { id: 'm1', act: 'done', from: 'agent-x', card: 'SYN-D1', subject: 'SYN-D2 aaaaaa1', body: 'also bbbbbb2', created_at: '2026-10-02T00:00:00Z' },
    { id: 'm1', act: 'done', card: 'SYN-D1', subject: 'a second copy of m1', body: 'cccccc3' },
    { id: 'm2', act: 'done', from: 'agent-y', subject: 'SYN-D2 shipped', body: 'range aaaaaa1..dddddd4, 1234567 is no sha and fedcba9 no commit', created_at: '2026-10-03T00:00:00Z' },
    { id: 'm3', act: 'done', subject: 'no card here', body: 'SYN-D3 at cccccc3' },
    { id: 'm4', act: 'done', subject: 'SYN-D1 and SYN-D2', body: 'dddddd4' },
    { id: 'm5', act: 'inform', subject: 'SYN-D1', body: 'dddddd4' },
    { id: 'm6', act: 'done', subject: 'SYN-D1 nothing', body: 'no shas' },
    { id: 'm7', act: 'done', card: 'SYN-D1', subject: 'again', body: 'aaaaaa1', created_at: '2026-10-01T00:00:00Z' },
    { id: 'm8', act: 'done', subject: 'SYN-D3 follow-up', body: 'like SYN-D1 at bbbbbb2' },
    { id: 'm9', act: 'done', card: 'SYN-D2', subject: 'names fedcba9 only', created_at: '2026-10-05T00:00:00Z' },
    { id: 'm10', act: 'done', subject: 'nothing known', body: 'at aaaaaa1' },
    { id: 'm11', act: 'done', from: 'agent-x', card: 'SYN-D1', subject: 'later', body: 'cccccc3', created_at: '2026-10-04T00:00:00Z' },
  ];
  const r = await F.doneMailFacts(mails, ['SYN-D1', 'SYN-D2', 'SYN-D3'], g);
  const bySlot = Object.fromEntries(r.facts.map((f) => [f.slot, f]));
  assert.deepEqual(Object.keys(bySlot).sort(), [
    'card.syn-d1.donesha#agent-x', 'card.syn-d1.donesha#unknown', 'card.syn-d2.donesha#agent-y', 'card.syn-d3.donesha#unknown',
  ]);
  const commit = (s) => bySlot[s].refs.find((y) => y.type === 'commit').value;
  assert.equal(commit('card.syn-d1.donesha#agent-x'), H('c'), 'the sender\'s newest mail (m11) wins over m1');
  assert.match(bySlot['card.syn-d1.donesha#agent-x'].text, /^Card SYN-D1: the newest done mail from agent-x \(m11\) names commit cccccccc \(c{40}\)$/);
  assert.equal(commit('card.syn-d1.donesha#unknown'), H('a'));
  assert.equal(commit('card.syn-d3.donesha#unknown'), H('b'), 'm8 (by id after m3, both undated)');
  const d2 = bySlot['card.syn-d2.donesha#agent-y'];
  assert.equal(commit('card.syn-d2.donesha#agent-y'), H('d'), 'one commit per claim: the latest in git order of those it names');
  assert.match(d2.text, /\(the end of the range aaaaaa1\.\.dddddd4\); it is the latest in git order of the 2 commits the mail names$/);
  assert.equal((d2.text.match(/[0-9a-f]{40}/g) || []).length, 1, 'F7: one value per claim');
  assert.deepEqual(d2.refs, [{ type: 'task', value: 'SYN-D2' }, { type: 'msg', value: 'm2' }, { type: 'commit', value: H('d') }]);
  assert.equal(d2.at, '2026-10-03T00:00:00.000Z');
  assert.equal(r.facts.some((f) => f.refs.some((y) => y.type === 'commit' && y.value.startsWith('fedcba9'))), false, 'a hex word git does not know is no commit');
  assert.deepEqual(r.skipped, { notDone: 1, noShaWord: 1, noCommit: 1, noCard: 1, ambiguous: 1, bodyOnly: 1 });
  assert.deepEqual(r.skips, [
    { mail: 'm10', reason: 'noCard' }, { mail: 'm3', reason: 'bodyOnly', cards: ['SYN-D3'] }, { mail: 'm4', reason: 'ambiguous', cards: ['SYN-D1', 'SYN-D2'] }, { mail: 'm5', reason: 'notDone' }, { mail: 'm6', reason: 'noShaWord' }, { mail: 'm9', reason: 'noCommit' },
  ]);
  assert.equal(r.older, 1, 'm1 (agent-x on SYN-D1): an older mail of its (card, sender); m3 names SYN-D3 only in its body and the commit subject does not: no card (F1, CLAIMS-WEAKLINK-DONESHA)');
  // Round 2 (Jim M-a): a subject-named card from a mail with no card field takes the same git check.
  const blind = await F.doneMailFacts([mails[2], mails[8]], ['SYN-D1', 'SYN-D2', 'SYN-D3'], fakeGit({ commits: { aaaaaa1: H('a'), bbbbbb2: H('b'), dddddd4: H('d') }, parents: {}, time: {} }));
  assert.deepEqual(blind.facts, [], 'no message port: a subject-named card is never confirmed');
  assert.deepEqual(blind.skips, [{ mail: 'm8', reason: 'ambiguous', cards: ['SYN-D3'] }, { mail: 'm2', reason: 'ambiguous', cards: ['SYN-D2'] }]);
  // A mail naming several cards: git settles it when the messages of its commits name exactly one of them.
  const gm = fakeGit({ commits: { dddddd4: H('d'), eeeeee5: H('e') }, parents: {}, time: {}, messages: { [H('d')]: 'SYN-D2: fix the thing', [H('e')]: 'unrelated' } });
  const settled = await F.doneMailFacts([{ id: 'm4', act: 'done', from: 'agent-z', subject: 'SYN-D1 and SYN-D2', body: 'dddddd4 eeeeee5' }], ['SYN-D1', 'SYN-D2'], gm);
  assert.deepEqual(settled.facts.map((f) => f.slot), ['card.syn-d2.donesha#agent-z']);
  const still = await F.doneMailFacts([{ id: 'm4', act: 'done', subject: 'SYN-D1 and SYN-D2', body: 'eeeeee5' }], ['SYN-D1', 'SYN-D2'], gm);
  assert.deepEqual(still.skips, [{ mail: 'm4', reason: 'ambiguous', cards: ['SYN-D1', 'SYN-D2'] }], 'git names neither: ambiguous');
  // A card id the subject writes exactly beats one the delivery inherited (reply/conversation link)
  // when a commit subject confirms it (round 2); unconfirmed, the mail gives nothing (never the link
  // the subject contradicts); a spelling variant (a space for the dash) never links, with or without
  // a link (god c33130, c19239); with no card in the subject the inherited link counts; a body
  // mention never beats a link.
  const linked = await F.doneMailFacts([{ id: 'm12', act: 'done', from: 'agent-x', cards: ['syn-d3'], subject: 'SYN-D1', body: 'aaaaaa1' }], ['SYN-D1', 'SYN-D3'], g);
  assert.deepEqual(linked.facts.map((f) => f.slot), ['card.syn-d1.donesha#agent-x']);
  const contradicted = await F.doneMailFacts([{ id: 'm17', act: 'done', from: 'agent-x', cards: ['syn-d3'], subject: 'SYN-D1', body: 'dddddd4' }], ['SYN-D1', 'SYN-D3'], g);
  assert.deepEqual(contradicted.facts, [], 'the subject names SYN-D1, no commit subject confirms it: not SYN-D1, and never the contradicted link');
  assert.deepEqual(contradicted.skips, [{ mail: 'm17', reason: 'ambiguous', cards: ['SYN-D1'] }]);
  // CLAIMS-WEAKLINK-DONESHA round 3 (C): the link counts only when no reported commit's subject names
  // a different card; commit a names SYN-D1 (and SYN-D2), so a syn-d3 link reporting it gives nothing.
  const variant = await F.doneMailFacts([{ id: 'm15', act: 'done', from: 'agent-x', cards: ['syn-d3'], subject: 'SYN D1', body: 'aaaaaa1' }], ['SYN-D1', 'SYN-D3'], g);
  assert.deepEqual(variant.facts, [], 'a variant never beats a link, and the link does not count on another card\'s commit');
  assert.deepEqual(variant.skips, [{ mail: 'm15', reason: 'ambiguous', cards: ['SYN-D3', 'SYN-D1'] }]);
  const variantAlone = await F.doneMailFacts([{ id: 'm16', act: 'done', from: 'agent-x', subject: 'temp leak fixed', body: 'aaaaaa1' }], ['TEMP-LEAK', 'SYN-D3'], g);
  assert.deepEqual(variantAlone.facts, [], 'a variant-only subject links no card');
  assert.deepEqual(variantAlone.skips, [{ mail: 'm16', reason: 'noCard' }]);
  const inherited = await F.doneMailFacts([{ id: 'm13', act: 'done', from: 'agent-x', cards: ['syn-d3'], subject: 'stage sweep', body: 'SYN-D1 aaaaaa1' }], ['SYN-D1', 'SYN-D3'], g);
  assert.deepEqual(inherited.facts, [], "round 3 (C): the commit's subject names SYN-D1, not the linked card");
  assert.deepEqual(inherited.skips, [{ mail: 'm13', reason: 'ambiguous', cards: ['SYN-D3', 'SYN-D1'] }]);
  const inheritedPlain = await F.doneMailFacts([{ id: 'm18', act: 'done', from: 'agent-x', cards: ['syn-d3'], subject: 'stage sweep', body: 'dddddd4' }], ['SYN-D1', 'SYN-D3'], g);
  assert.deepEqual(inheritedPlain.facts.map((f) => f.slot), ['card.syn-d3.donesha#agent-x'], 'a commit naming no card still counts with the link');
  const both = await F.doneMailFacts([{ id: 'm14', act: 'done', from: 'agent-x', cards: ['syn-d3'], subject: 'SYN-D1 and SYN-D3', body: 'aaaaaa1' }], ['SYN-D1', 'SYN-D3'], g);
  assert.deepEqual(both.facts, [], "several in the subject, the linked one among them: still nothing on another card's commit");
  assert.deepEqual(both.skips, [{ mail: 'm14', reason: 'ambiguous', cards: ['SYN-D3', 'SYN-D1'] }]);
  const bothPlain = await F.doneMailFacts([{ id: 'm19', act: 'done', from: 'agent-x', cards: ['syn-d3'], subject: 'SYN-D1 and SYN-D3', body: 'dddddd4' }], ['SYN-D1', 'SYN-D3'], g);
  assert.deepEqual(bothPlain.facts.map((f) => f.slot), ['card.syn-d3.donesha#agent-x'], 'several in the subject: the linked one among them');
});

// ———————————————————————————————————————————————————— the writer

test('writer: idempotent (no claim and no sighting on a re-run), a change supersedes its own claim, slots stay apart', async () => {
  const x = setup();
  const f1 = [
    { slot: 'card.syn-w.status', key: 'card.syn-w.status', kind: 'fact', text: 'Card SYN-W status: doing', at: '2026-10-01T00:00:00.000Z', refs: [{ type: 'task', value: 'SYN-W' }] },
    { slot: 'card.syn-w.donesha#agent-a', key: 'card.syn-w.donesha', kind: 'fact', text: `Card SYN-W: the newest done mail from agent-a (m1) names commit aaaaaaaa (${H('a')})`, at: '2026-10-01T01:00:00.000Z', refs: [{ type: 'commit', value: H('a') }] },
    { slot: 'card.syn-w.donesha#agent-b', key: 'card.syn-w.donesha', kind: 'fact', text: `Card SYN-W: the newest done mail from agent-b (m2) names commit bbbbbbbb (${H('b')})`, at: '2026-10-01T02:00:00.000Z', refs: [{ type: 'commit', value: H('b') }] },
  ];
  assert.deepEqual(await W.syncDerived(x.deps, f1), { facts: 3, appended: 3, unchanged: 0, superseded: 0, failed: 0 });
  assert.deepEqual(await W.syncDerived(x.deps, f1), { facts: 3, appended: 0, unchanged: 3, superseded: 0, failed: 0 });
  assert.equal(x.events().length, 0, 'no R1 sighting events');
  const first = x.claims()[0].id;
  const f2 = [{ ...f1[0], text: 'Card SYN-W status: done', at: '2026-10-02T00:00:00.000Z' }, f1[1], f1[2]];
  assert.deepEqual(await W.syncDerived(x.deps, f2), { facts: 3, appended: 1, unchanged: 2, superseded: 1, failed: 0 });
  const live = x.live();
  assert.equal(live.length, 3);
  const st = live.find((c) => c.key === 'card.syn-w.status');
  assert.equal(st.text, 'Card SYN-W status: done');
  assert.deepEqual(st.supersedes, [first]);
  assert.equal(st.supersedesReason.category, 'changed');
  // A fact older than the slot's live claim never replaces it.
  assert.equal((await W.syncDerived(x.deps, f1)).older, 1);
  // Back to the earlier value, newer: a new claim (the old one is superseded, not live), not a sighting.
  const back = [{ ...f1[0], at: '2026-10-03T00:00:00.000Z' }, f1[1], f1[2]];
  assert.equal((await W.syncDerived(x.deps, back)).appended, 1);
  assert.equal(x.events().length, 0);
  assert.equal(x.live().find((c) => c.key === 'card.syn-w.status').text, 'Card SYN-W status: doing');
  // A refs change alone is a change.
  assert.equal((await W.syncDerived(x.deps, [{ ...back[0], refs: [{ type: 'task', value: 'SYN-W' }, { type: 'msg', value: 'm9' }] }])).appended, 1);
  // A refused append is counted and logged, never thrown.
  const bad = await W.syncDerived(x.deps, [{ slot: 'card.syn-w.x', key: 'card.syn-w.x', kind: 'fact', text: 'y'.repeat(401), at: '2026-10-01T00:00:00.000Z', refs: [] }]);
  assert.equal(bad.failed, 1);
  assert.ok(x.logs.some((r) => r.kind === 'claims-derived-append-failed'));
  assert.ok(x.claims().every((c) => c.source === 'derived'));
});

test('writer: another source\'s claim in the slot is never superseded or counted', () => {
  assert.equal(W.slotOf({ key: 'card.a.donesha', text: `Card A: the newest done mail from agent-x (m1) names commit aaaaaaaa (${H('a')})` }), 'card.a.donesha#agent-x');
  assert.equal(W.slotOf({ key: 'card.a.donesha', text: `Card A: the done mail m1 from agent-y names commit aaaaaaaa (${H('a')})` }), 'card.a.donesha#agent-y', 'M5\'s per-commit claims fall in their sender\'s slot');
  assert.equal(W.slotOf({ key: 'card.a.donesha', refs: [{ type: 'commit', value: H('a') }] }), null);
  assert.equal(W.slotOf({ key: 'card.a.donesha' }), null);
  assert.equal(W.slotOf({ key: 'card.a.status' }), 'card.a.status');
  assert.equal(W.slotOf({}), null);
});

// ———————————————————————————————————————————————————— the backfill over a fixture hive + repo

/**
 * Deliver a mail as main does: the inbox copy (in inbox/<sub>) plus its MailLedger entry in
 * state/mail/<agent>.json. `edited` overwrites fields of the inbox copy after delivery.
 */
function deliver(x, agent, msg, sub = '', edited = null) {
  const inbox = path.join(x.root, 'agents', agent, 'inbox', sub);
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, `${msg.id}.json`), JSON.stringify({ ...msg, ...(edited || {}) }));
  const f = path.join(x.root, 'state', 'mail', `${agent}.json`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  let doc;
  try { doc = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { doc = { version: 1, agentId: agent, nextSeq: 1, lastActivityAt: null, lastActedAt: null, entries: {} }; }
  const seq = doc.nextSeq++;
  doc.entries[msg.id] = { id: msg.id, from: msg.from ?? 'god', act: msg.act, subject: msg.subject ?? '', ...(msg.card ? { cardId: msg.card } : {}), bodyHash: mailBodyHash(msg.body ?? ''), seq, deliveredAt: Date.parse(msg.created_at ?? '2026-10-03T12:00:00Z'), state: 'acted' };
  fs.writeFileSync(f, JSON.stringify(doc));
}

function fixtureHive(x, r) {
  // Round 2 (CLAIMS-WEAKLINK-DONESHA): m-h1 below has no card field, so a commit SUBJECT must name SYN-H2.
  const a = r.commit('SYN-H2: first', '2026-10-01T10:00:00Z');
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
  fs.writeFileSync(path.join(x.root, 'tasks-archive', '2026-10.jsonl'), `${JSON.stringify({ at: '2026-10-03T13:00:00Z', card: { id: 'SYN-A1', title: 'Archived', status: 'done', result: `done at ${c.slice(0, 8)}` } })}\n`);
  for (const ag of ['agent-x', 'agent-y']) fs.mkdirSync(path.join(x.root, 'agents', ag, 'inbox', '.done'), { recursive: true });
  const mail = { id: 'm-h1', act: 'done', from: 'agent-x', to: 'god', subject: 'SYN-H2 shipped', body: `range ${a.slice(0, 8)}..${c.slice(0, 8)}`, created_at: '2026-10-03T12:00:00Z' };
  deliver(x, 'agent-x', mail, '.done');
  deliver(x, 'agent-y', mail);
  deliver(x, 'agent-y', { id: 'm-h2', act: 'request', from: 'god', subject: 'SYN-H1', body: b });
  // Jim's M5 audit MUST 1: none of these may give a fact. A done mail planted in an agent's own
  // inbox/.done, never delivered (no ledger entry), "from god" and naming SYN-H2 and commit b:
  fs.writeFileSync(path.join(x.root, 'agents', 'agent-x', 'inbox', '.done', 'm-forge.json'), JSON.stringify({ id: 'm-forge', act: 'done', from: 'god', card: 'SYN-H2', subject: 'SYN-H2', body: b }));
  // a done copy of a mail the ledger delivered as a request:
  fs.writeFileSync(path.join(x.root, 'agents', 'agent-y', 'inbox', '.done', 'm-h2.json'), JSON.stringify({ id: 'm-h2', act: 'done', from: 'god', card: 'SYN-H2', subject: 'SYN-H2', body: b }));
  // and a delivered done mail whose inbox copy was edited to name b (its body no longer hashes to the
  // ledger's, so only the ledger's subject counts).
  deliver(x, 'agent-x', { id: 'm-h5', act: 'done', from: 'agent-x', subject: 'SYN-H2 follow-up', body: 'no commit named' }, '', { body: `now names ${b}` });
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
  assert.equal(c1.doneMails, 3, 'm-h1 from both ledgers (they fold by id) and m-h5; the forged, retyped and unrecorded files are not read');
  assert.equal(c1.decisions.appended, 1);
  assert.equal(c1.cardFields.appended, 4 + 3 + 4, 'SYN-H1 and SYN-A1 status/assignee/fixversion/lastsha, SYN-H2 status/assignee/fixversion (no commit named)');
  const live = Object.fromEntries(x.live().filter((c) => !c.key.endsWith('.donesha')).map((c) => [c.key, c]));
  assert.match(live['card.syn-h1.lastsha'].text, new RegExp(`${s.side}\\)$`), 'unrelated lines: the side commit is later by time');
  assert.match(live['card.syn-a1.lastsha'].text, new RegExp(`${s.c}\\)$`), 'archived cards count');
  assert.equal(c1.releases.appended, 1 + 1 + 3 + 1 + 1, 'release.9.1.2 + its tag + 3 entries, release.9.1.1 + 1 entry');
  assert.match(live['release.9.1.2'].text, new RegExp(`tag v9\\.1\\.2 is commit ${s.c}`));
  // L1/L4 (god 69bc66): each field claim carries its value on its own; release.<v> itself stays prose.
  assert.equal(live['release.9.1.2.tag'].value, s.c);
  assert.equal(live['release.9.1.2'].value, undefined);
  assert.equal(live['card.syn-h1.lastsha'].value, s.side);
  assert.equal(live['card.syn-a1.lastsha'].value, s.c);
  for (const k of ['status', 'assignee', 'fixversion']) assert.equal(typeof live[`card.syn-h2.${k}`].value, 'string', k);
  const doneRow = x.live().find((c) => c.key === 'card.syn-h2.donesha');
  assert.deepEqual([doneRow.value, doneRow.valueAgent], [s.c, 'agent-x']);
  const done = x.live().filter((c) => c.key === 'card.syn-h2.donesha').map((c) => c.refs.find((y) => y.type === 'commit').value).sort();
  assert.deepEqual(done, [s.c], 'one claim for (SYN-H2, agent-x): the range end c, later in git order than a; never b (forged, retyped or edited mails)');
  assert.equal(c1.doneShas.appended, 1);
  assert.deepEqual(c1.doneSkipped, { notDone: 0, noShaWord: 1, noCommit: 0, noCard: 0, ambiguous: 0, bodyOnly: 0 });
  assert.deepEqual(x.logs.filter((r) => r.kind === 'claims-derived-done-skip'), [{ kind: 'claims-derived-done-skip', mail: 'm-h5', reason: 'noShaWord' }], 'R2 (c): the skip is logged with its reason');
  assert.equal(c1.gitShas.appended, 1, 'commit a names SYN-H2 in its subject (card.syn-h2.gitsha); no other commit names a card');
  assert.equal(c1.decisions.failed + c1.cardFields.failed + c1.releases.failed + c1.doneShas.failed, 0);
  const c2 = await W.runDerivedBackfill(x.deps, input);
  for (const k of ['decisions', 'cardFields', 'releases', 'doneShas', 'gitShas']) assert.equal(c2[k].appended, 0, k);
  assert.equal(x.events().length, 0);
  assert.deepEqual(fs.readdirSync(path.join(x.root, 'agents')).sort(), ['agent-x', 'agent-y', 'derived']);
  assert.deepEqual(W.readDoneMails(x.root).map((m) => [m.id, m.from, m.card ?? null, typeof m.body]), [['m-h1', 'agent-x', null, 'string'], ['m-h5', 'agent-x', null, 'undefined'], ['m-h1', 'agent-x', null, 'string']], 'from, card and subject come from the ledger; an edited body is dropped');
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

test('R2 (a): the sender\'s newer done mail supersedes its older claims (M5 per-commit ones too); other senders stay; an older fact never replaces a newer claim', async () => {
  const x = setup();
  const legacy = (sha, from, mail) => ({ t: 'claim', kind: 'fact', key: 'card.syn-r.donesha', source: 'derived', text: `Card SYN-R: the done mail ${mail} from ${from} names commit ${sha.slice(0, 8)} (${sha})`, refs: [{ type: 'commit', value: sha }], at: '2026-10-01T00:00:00.000Z' });
  for (const d of [legacy(H('a'), 'agent-x', 'm1'), legacy(H('b'), 'agent-x', 'm1'), legacy(H('c'), 'agent-y', 'm2')]) assert.equal((await x.store.appendRecord(D, d, 'derived-internal')).ok, true);
  const [la, lb, lc] = x.claims().map((c) => c.id);
  const g = fakeGit({ commits: { dddddd4: H('d') }, parents: {}, time: {} });
  const r = await F.doneMailFacts([{ id: 'm3', act: 'done', from: 'agent-x', card: 'SYN-R', subject: 'dddddd4', created_at: '2026-10-02T00:00:00Z' }], ['SYN-R'], g);
  assert.deepEqual(await W.syncDerived(x.deps, r.facts), { facts: 1, appended: 1, unchanged: 0, superseded: 2, failed: 0 });
  const live = x.live();
  assert.deepEqual(live.map((c) => c.refs.find((y) => y.type === 'commit').value).sort(), [H('c'), H('d')], 'agent-y\'s claim stays live beside agent-x\'s newest');
  const nw = live.find((c) => c.text.includes('agent-x'));
  assert.deepEqual([...nw.supersedes].sort(), [la, lb].sort());
  assert.equal(nw.supersedesReason.category, 'changed');
  assert.ok(x.claims().some((c) => c.id === lc) && x.claims().length === 4, 'nothing deleted');
  // An older mail's fact (a pass that no longer sees the newer one) does not replace the newer claim.
  const old = await F.doneMailFacts([{ id: 'm0', act: 'done', from: 'agent-x', card: 'SYN-R', subject: 'dddddd4 again', created_at: '2026-09-30T00:00:00Z' }], ['SYN-R'], g);
  const kept = await W.syncDerived(x.deps, old.facts);
  assert.equal(kept.appended, 0);
  assert.equal(kept.older, 1);
});

test('R2 (b): done mails from main\'s permanent mail-cards index (merged with the MailLedger by id); a body counts only when it hashes; git history facts', async () => {
  const x = setup();
  const r = makeRepo();
  const a = r.commit('SYN-G1: first step', '2026-10-01T10:00:00Z');
  const b = r.commit('second step for SYN-G1 and SYN G2', '2026-10-02T10:00:00Z');
  r.commit('unrelated', '2026-10-03T10:00:00Z');
  r.commit(`Merge guppy/lone @${a.slice(0, 8)} into int-9.1.2`, '2026-10-03T11:00:00Z');
  const dir = path.join(x.root, 'state', 'mail-cards');
  fs.mkdirSync(dir, { recursive: true });
  const row = (o) => JSON.stringify({ v: 1, act: 'done', trust: 'two-party', ...o, bodyHash: mailBodyHash(o.hashOf ?? o.body ?? '') });
  fs.writeFileSync(path.join(dir, 'syn-g1.jsonl'), [
    row({ id: 'm-i1', card: 'SYN-G1', cards: ['SYN-G1'], cardFrom: 'reply', from: 'agent-x', to: 'god', subject: 'shipped', body: `at ${a.slice(0, 8)}`, created_at: '2026-10-01T12:00:00Z' }),
    row({ id: 'm-i1', card: 'SYN-G1', cards: ['SYN-G1'], cardFrom: 'reply', from: 'agent-x', to: 'jim', subject: 'shipped', body: `at ${a.slice(0, 8)}`, created_at: '2026-10-01T12:00:00Z' }),
    row({ id: 'm-i2', card: 'SYN-G1', cards: ['SYN-G1'], cardFrom: 'field', from: 'agent-y', to: 'god', subject: 'edited', body: `now ${b.slice(0, 8)}`, hashOf: 'the delivered body', created_at: '2026-10-02T12:00:00Z' }),
    row({ id: 'm-i3', card: 'SYN-G1', cards: ['SYN-G1'], cardFrom: 'field', from: 'agent-y', to: 'god', act: 'inform', subject: 'fyi', body: b }),
    '{torn',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, '_links.jsonl'), `${JSON.stringify({ v: 1, mailId: 'm-i1', cards: ['SYN-G1'], method: 'reply', act: 'done' })}\n${row({ id: 'm-i9', card: 'SYN-G1', cardFrom: 'field', from: 'agent-z', subject: 'not a mail file', body: `at ${a.slice(0, 8)}` })}\n`);
  deliver(x, 'agent-x', { id: 'm-i1', act: 'done', from: 'agent-x', subject: 'shipped', body: `at ${a.slice(0, 8)}`, created_at: '2026-10-01T12:00:00Z' });
  const mails = W.readDoneMails(x.root);
  assert.deepEqual(mails.map((m) => [m.id, m.from, JSON.stringify(m.cards ?? null), typeof m.body]), [['m-i1', 'agent-x', '["SYN-G1"]', 'string'], ['m-i2', 'agent-y', '["SYN-G1"]', 'undefined']], 'one per id; the ledger copy folds into the index row; a body that does not hash is dropped; not-done rows and _links are not read');
  const seen = new Set();
  assert.equal(W.readDoneMails(x.root, seen).length, 2);
  assert.equal(W.readDoneMails(x.root, seen).length, 0, 'a pass reads each index row once');
  fs.writeFileSync(path.join(x.root, 'tasks.json'), JSON.stringify({ tasks: [{ id: 'SYN-G1', status: 'done' }, { id: 'SYN-G2', status: 'todo' }] }));
  const git = new DerivedGit(r.repo);
  const facts = await F.gitHistoryFacts(await git.log(), ['SYN-G1', 'SYN-G2'], git);
  assert.deepEqual(facts.map((f) => [f.key, f.refs[1].value]), [['card.syn-g1.gitsha', b], ['card.syn-g2.gitsha', b]]);
  assert.match(facts[0].text, new RegExp(`^Card SYN-G1: the latest commit in git order whose message names the card is ${b.slice(0, 8)} \\(${b}\\); 2 commits name it$`));
  assert.equal(facts[0].at, '2026-10-02T10:00:00.000Z');
  // More than 8 commits name a card: the 8 NEWEST are compared, so the newest wins.
  let last = '';
  for (let i = 0; i < 10; i++) last = r.commit(`SYN-G3 step ${i}`, `2026-10-0${4 + Math.floor(i / 5)}T1${i % 5}:00:00Z`);
  const g3 = await F.gitHistoryFacts(await git.log(), ['SYN-G3'], git);
  assert.equal(g3[0].refs[1].value, last, 'the newest of 10');
  assert.match(g3[0].text, /; 10 commits name it$/);
  const c = await W.runDerivedBackfill(x.deps, { hiveRoot: x.root, git, releases: { changelog: null, tags: [] } });
  assert.equal(c.gitShas.appended, 2);
  assert.equal(c.merges.appended, 1, 'branch.lone: a merge subject (god c33130)');
  assert.equal(c.doneShas.appended, 1, 'm-i1 (agent-x): commit a; m-i2 has no body that hashes and no sha in its subject');
  assert.deepEqual(c.doneSkipped, { notDone: 0, noShaWord: 1, noCommit: 0, noCard: 0, ambiguous: 0, bodyOnly: 0 });
  assert.equal((await W.runDerivedBackfill(x.deps, { hiveRoot: x.root, git, releases: { changelog: null, tags: [] } })).gitShas.appended, 0, 'idempotent');
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
  assert.equal(out.doneShas.appended, 1);
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

test('backfill CLI: refuses the live hive in any spelling or from above, the app\'s own user data and a foreign key record', async () => {
  const x = setup();
  const r = makeRepo();
  fixtureHive(x, r);
  await x.store.appendRecord(D, fact('seed', { key: 'card.seed.status' }), 'derived-internal');
  x.store.close();
  const key = Buffer.from(x.keys.load().key).toString('hex');
  const cli = path.join(__dirname, '..', 'scripts', 'claims-derived-backfill.cjs');
  const liveHive = path.join(JAIL, 'live-hive');
  fs.mkdirSync(path.join(liveHive, 'sub'), { recursive: true });
  const appData = path.join(JAIL, 'appdata-local');
  fs.mkdirSync(path.join(appData, 'Munder Difflin', 'Guppy'), { recursive: true });
  const run = (args, input = `${key}\n`) => spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', env: { ...process.env, MUNDER_HIVE_ROOT: liveHive, LOCALAPPDATA: appData, APPDATA: '' }, timeout: 120_000 });
  const refused = (args, re, why) => { const p = run(args); assert.equal(p.status, 2, `${why}: ${p.stdout}`); assert.match(p.stderr, re, why); };
  const ud = `${x.root}-ud`;
  // SHOULD a: other spellings of the live hive, and a folder above it.
  refused(['--hive', `\\\\?\\${liveHive}`, '--user-data', ud], /never the live hive/, 'the \\\\?\\ form');
  refused(['--hive', JAIL, '--user-data', ud], /never the live hive/, 'an ancestor of the live hive');
  refused(['--hive', path.join(liveHive, 'sub', '..', 'sub'), '--user-data', ud], /never the live hive/, 'a dotted subfolder');
  const unc = /^([a-zA-Z]):\\(.*)$/.exec(liveHive);
  const share = unc ? `\\\\localhost\\${unc[1]}$\\${unc[2]}` : null;
  if (share && fs.existsSync(share)) refused(['--hive', share, '--user-data', ud], /never the live hive/, 'the admin share');
  // SHOULD b: the app's own user data (or a folder in or above it), and a record of another hive or key.
  refused(['--hive', x.root, '--user-data', path.join(appData, 'Munder Difflin', 'Guppy')], /never the app's own user data/, 'the app user data');
  refused(['--hive', x.root, '--user-data', appData], /never the app's own user data/, 'above the app user data');
  const foreign = path.join(JAIL, 'ud-foreign');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, KEY_RECORD_FILE), JSON.stringify({ v: 1, hives: { '0123456789abcdef': { keyId: 'k', at: '2026-10-01T00:00:00Z' } } }));
  refused(['--hive', x.root, '--user-data', foreign], /claims-mac\.hives\.json in --user-data belongs to another hive or key/, 'another hive in the key record');
  const otherKey = path.join(JAIL, 'ud-other-key');
  fs.mkdirSync(otherKey);
  fs.writeFileSync(path.join(otherKey, KEY_RECORD_FILE), JSON.stringify({ v: 1, hives: { [hiveIdOf(x.root)]: { keyId: 'not-this-key', at: '2026-10-01T00:00:00Z' } } }));
  refused(['--hive', x.root, '--user-data', otherKey], /belongs to another hive or key/, 'another key for this hive');
  assert.deepEqual(fs.readdirSync(foreign), [KEY_RECORD_FILE], 'a refused run writes nothing');
  assert.deepEqual(fs.readdirSync(path.join(appData, 'Munder Difflin', 'Guppy')), []);
  // The record a run over this same copy wrote (this hive, this key) is accepted.
  const ok = run(['--hive', x.root, '--user-data', ud, '--repo', r.repo, '--now', '2026-10-04T00:00:00Z']);
  assert.equal(ok.status, 0, `${ok.stderr}${ok.stdout}`);
});

test('git port: a hung git is killed at the timeout and the call rejects (execFile and the stdin pipe)', async () => {
  const r = makeRepo();
  const hang = [process.execPath, '-e', 'setTimeout(() => {}, 60000)', '--'];
  const g = new DerivedGit(r.repo, { timeoutMs: 400, command: hang });
  const t0 = Date.now();
  await assert.rejects(g.ok(), /git rev-parse timed out after 400 ms/);
  await assert.rejects(g.prefetch(['abcdef1']), /git cat-file timed out after 400 ms/);
  assert.ok(Date.now() - t0 < 20_000, 'both calls end at their timeout');
  assert.equal(GIT_TIMEOUT_MS >= 30_000 && GIT_TIMEOUT_MS <= 60_000, true, 'the default is 30-60 s');
  assert.equal(await new DerivedGit(r.repo).ok(), true, 'a normal git is unchanged');
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
  deliver(x, 'agent-x', { id: 'm-h3', act: 'done', from: 'agent-x', card: 'SYN-H1', subject: 'x', body: r.g(['rev-parse', 'HEAD~1']) });
  await live.run('pass', () => live.pass());
  assert.equal(x.claims().length, n1 + 1);
  await live.run('pass', () => live.pass());
  assert.equal(x.claims().length, n1 + 1, 'a second pass writes nothing');
  // A mail already seen (agent/id) is not read again, even if its ledger entry and copy change (a pass
  // reads only newly recorded done mails; the start backfill reads all).
  deliver(x, 'agent-x', { id: 'm-h3', act: 'done', from: 'agent-x', card: 'SYN-H1', subject: 'x', body: r.g(['rev-parse', 'HEAD~2']) });
  await live.run('pass', () => live.pass());
  assert.equal(x.claims().length, n1 + 1, 'the seen mail is not re-read');
  // A ruling mail lands in the per-card mail index (no registry: god is 'god'); the pass writes it.
  fs.mkdirSync(path.join(x.root, 'state', 'mail-cards'), { recursive: true });
  fs.writeFileSync(path.join(x.root, 'state', 'mail-cards', 'syn-h1.jsonl'), `${JSON.stringify({ v: 1, id: 'm-h4', card: 'SYN-H1', cards: ['SYN-H1'], cardFrom: 'field', from: 'god', to: 'agent-x', act: 'inform', subject: 'RULING: ship it', created_at: '2026-10-03T14:00:00Z' })}\n`);
  await live.run('pass', () => live.pass());
  assert.equal(x.claims().length, n1 + 2, 'the live pass writes the ruling');
  assert.ok(x.claims().some((c) => /^card\.syn-h1\.decision\.m[0-9a-f]{8}$/.test(c.key)));
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

test('R2 (d): a note retires only the writer\'s own same-key claim it restates (a value changed); card.* stays multi', () => {
  const V = loadTs('src/main/claims/valueSupersede.ts');
  const E = loadTs('src/main/claims/endpoint.ts');
  assert.equal(V.restates('Card SYN-A1 is pushed to origin at abc1234 on branch b', 'Card SYN-A1 is pushed to origin at 0f1e2d3 on branch b'), true, 'a changed sha');
  assert.equal(V.restates('Release v1.2.4 of the tool shipped on 2026-01-03 with 7 fixes', 'Release v1.2.3 of the tool shipped on 2026-01-02 with 5 fixes'), true, 'versions, dates, counts');
  assert.equal(V.restates('Card SYN-A1 is pushed to origin at abc1234 on branch b', 'Card SYN-A1 is pushed to origin at abc1234 on branch b'), false, 'the same value is a duplicate, not a change');
  assert.equal(V.restates('Card SYN-A1 tests pass on the branch now', 'Card SYN-A1 tests fail on the branch now'), false, 'no value word: a different fact');
  assert.equal(V.restates('Card SYN-A1 build abc1234 passed its gate', 'Card SYN-A1 review 0f1e2d3 passed its gate'), false, 'other words: a different fact, even with a new value');
  assert.equal(V.restates('at abc1234', 'at 0f1e2d3'), false, 'too short to count');
  const live = { 'agent-a': [{ id: 'c-a1', text: 'Card SYN-A1 is pushed to origin at 0f1e2d3 on branch b' }, { id: 'c-a2', text: 'Card SYN-A1 needs a second reviewer before the cut' }] };
  const d = { liveByKey: (a) => (live[a] ?? []).map((c) => c.id), liveClaimsByKey: (a) => live[a] ?? [] };
  const note = { key: 'card.syn-a1', text: 'Card SYN-A1 is pushed to origin at abc1234 on branch b' };
  assert.deepEqual(E.sameKeyAuto(d, 'agent-a', note), ['c-a1'], 'only the restated claim');
  assert.deepEqual(E.sameKeyAuto(d, 'agent-b', note), [], 'another agent\'s claims are never touched');
  assert.deepEqual(E.sameKeyAuto(d, 'agent-a', { ...note, separate: 'c-a1' }), [], 'an explicit choice wins');
  assert.deepEqual(E.sameKeyAuto(d, 'agent-a', { ...note, fromMail: 'm1' }), [], 'a mail note never supersedes');
  const r = E.cardKeyRefusal(d, 'agent-a', note);
  assert.ok(r && r.ids.length === 1 && r.ids[0] === 'c-a2', 'the S3 refusal still lists the unrelated same-key claim');
  live['agent-a'].pop();
  assert.equal(E.cardKeyRefusal(d, 'agent-a', note), null, 'with only the restated claim left the note is written (and retires it)');
});

test('R2 (e) card record: the result and each note entry under card.<id>.decision.*, whole, in parts; keys stay as notes grow', async () => {
  const long = 'word '.repeat(150).trim();
  const card = { id: 'SYN-R1', doneAt: '2026-03-04T00:00:00Z', result: `closed: ${long}`, notes: '[2026-03-01T10:00:00.000Z] parked by the floor owner\n2026-03-02 voided, superseded by SYN-R2\n[2026-03-01T10:00:00.000Z] parked by the floor owner' };
  const facts = F.cardRecordFacts([card, { id: 'SYN-R0' }, { id: 'SYN-R3', notes: [{ by: 'god', text: 'kept' }] }]);
  const keys = facts.map((x) => x.key);
  assert.ok(keys.includes('card.syn-r1.decision.result') && keys.includes('card.syn-r1.decision.result.p2'), 'a long result goes on in parts');
  const res = facts.filter((x) => x.key.startsWith('card.syn-r1.decision.result'));
  assert.match(res[0].text, /^Card SYN-R1 result \(part 1 of \d\): closed: word/);
  assert.equal(res.map((x) => x.text.replace(/^[^:]*: /, '')).join(' '), `closed: ${long}`, 'nothing lost');
  const notes = facts.filter((x) => /\.decision\.n[0-9a-f]{8}$/.test(x.key) && x.key.startsWith('card.syn-r1'));
  assert.equal(notes.length, 2, 'one claim per distinct entry (a repeated entry once)');
  assert.equal(notes[0].text, 'Card SYN-R1 note: [2026-03-01T10:00:00.000Z] parked by the floor owner');
  assert.equal(notes[0].at, '2026-03-01T10:00:00.000Z');
  assert.equal(notes[1].at, '2026-03-02T00:00:00.000Z', 'a date with no time gives that day\'s start');
  assert.ok(facts.some((x) => x.key.startsWith('card.syn-r3.decision.n') && x.text.includes('"kept"')), 'an object note entry is kept as JSON');
  assert.ok(!keys.some((k) => k.startsWith('card.syn-r0')), 'no result, no notes: nothing');
  const grown = F.cardRecordFacts([{ ...card, notes: `${card.notes}\n[2026-03-03T09:00:00.000Z] reopened` }]);
  for (const n of notes) assert.ok(grown.some((g) => g.key === n.key && g.text === n.text), 'old entries keep their keys');
  const x = setup();
  fs.writeFileSync(path.join(x.root, 'tasks.json'), JSON.stringify({ tasks: [card] }));
  const c = await W.runDerivedBackfill(x.deps, { hiveRoot: x.root, git: null, releases: { changelog: null, tags: [] } });
  assert.equal(c.records.appended, facts.filter((f0) => f0.key.startsWith('card.syn-r1')).length);
  assert.equal((await W.runDerivedBackfill(x.deps, { hiveRoot: x.root, git: null, releases: { changelog: null, tags: [] } })).records.appended, 0, 'idempotent');
});

test('R2 (g) ruling mails: god mails saying RULING, linked by a trusted method, under card.<id>.decision.m<h8>, whole', async () => {
  const long = 'word '.repeat(150).trim();
  const id = (n) => `2026-10-25T00-00-00-000Z-0000${n}`;
  const row = (card, cardFrom, extra) => ({ v: 1, card, cards: [card], cardFrom, from: 'god', to: 'jim-1', act: 'request', created_at: '2026-10-25T08:00:00.000Z', ...extra });
  const withBody = (body) => ({ body, bodyHash: mailBodyHash(body) });
  const x = setup();
  fs.writeFileSync(path.join(x.root, 'registry.json'), JSON.stringify({ godId: 'god', agents: {} }));
  const dir = path.join(x.root, 'state', 'mail-cards');
  fs.mkdirSync(dir, { recursive: true });
  const rows = {
    'syn-g1': [
      row('SYN-G1', 'field', { id: id('a1'), subject: 'Split ruled', ...withBody(`RULING on the split: ${long}`), created_at: '2026-10-25T08:39:33.000Z' }),
      row('SYN-G1', 'mention-body', { id: id('a2'), subject: 'status', ...withBody('RULING: a body mention only') }),
      row('SYN-G1', 'field', { id: id('a3'), subject: 'next steps', ...withBody('please rebase') }),
      row('SYN-G1', 'field', { id: id('a4'), from: 'jim-1', subject: 'RULING proposal', ...withBody('mine') }),
      row('SYN-G1', 'field', { id: id('a5'), act: 'done', subject: 'RULING applied', ...withBody('done') }),
      row('SYN-G1', 'reply', { id: id('a6'), act: 'inform', subject: 'Ruling: keep both', body: 'tampered', bodyHash: mailBodyHash('the real body') }),
      row('SYN-G1', 'field', { id: id('a7'), subject: 'Split ruled', ...withBody('RULING: a second one, same subject') }),
    ],
    'syn-g2': [row('SYN-G2', 'mention-subject', { id: id('a1'), subject: 'Split ruled', ...withBody(`RULING on the split: ${long}`), created_at: '2026-10-25T08:39:33.000Z' })],
  };
  for (const [name, rs] of Object.entries(rows)) fs.writeFileSync(path.join(dir, `${name}.jsonl`), rs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, '_links.jsonl'), `${JSON.stringify(row('SYN-G1', 'field', { id: id('b1'), mailId: id('b1'), method: 'field', subject: 'RULING' }))}\n`);
  const mails = W.readIndexRulingMails(x.root);
  assert.deepEqual(mails.map((m) => [m.id, m.cards]).sort(), [[id('a1'), ['SYN-G1', 'SYN-G2']], [id('a6'), ['SYN-G1']], [id('a7'), ['SYN-G1']]],
    'god only, not done, says RULING or ruled; a mention-body link, a plain mail and the _links file never count');
  assert.equal(mails.find((m) => m.id === id('a6')).body, undefined, 'a body that does not hash to the row is not taken');
  assert.equal(F.isRulingMail({ from: 'god', act: 'inform', subject: 'status', body: 'a ruling is pending' }, 'god'), false, 'lower-case ruling in the body alone is not a ruling');
  const facts = F.rulingMailFacts(mails);
  const g1 = facts.filter((f0) => f0.key.startsWith('card.syn-g1.decision.m'));
  assert.equal(new Set(facts.map((f0) => f0.key)).size, facts.length, 'one key per mail (two rulings with one subject do not share one)');
  assert.ok(g1.length > 2 && g1.every((f0) => /^card\.syn-g1\.decision\.m[0-9a-f]{8}(\.p\d)?$/.test(f0.key)));
  const a1 = g1.filter((f0) => f0.refs.some((r) => r.type === 'msg' && r.value === id('a1')));
  assert.match(a1[0].text, /^Card SYN-G1 ruling \(part 1 of \d\): Split ruled — RULING on the split: word/);
  assert.equal(a1.map((f0) => f0.text.replace(/^[^:]*: /, '')).join(' '), `Split ruled — RULING on the split: ${long}`, 'whole, nothing lost');
  assert.equal(a1[0].at, '2026-10-25T08:39:33.000Z');
  assert.equal(g1.find((f0) => f0.refs.some((r) => r.value === id('a6'))).text, 'Card SYN-G1 ruling: Ruling: keep both');
  assert.ok(facts.some((f0) => f0.key.startsWith('card.syn-g2.decision.m')), 'each linked card gets the ruling');
  const c = await W.runDerivedBackfill(x.deps, { hiveRoot: x.root, git: null, releases: { changelog: null, tags: [] } });
  assert.equal(c.rulings.appended, facts.length);
  assert.equal((await W.runDerivedBackfill(x.deps, { hiveRoot: x.root, git: null, releases: { changelog: null, tags: [] } })).rulings.appended, 0, 'idempotent');
});

test('valid time (god e551de): every derived claim carries its source time; none is written without one; a run-stamped claim is re-dated', async () => {
  const x = setup();
  // no source time: never written (the store would stamp the run's time)
  const c0 = await W.syncDerived(x.deps, [{ slot: 'card.syn-v.status', key: 'card.syn-v.status', kind: 'fact', text: 'Card SYN-V status: done', refs: [] }]);
  assert.deepEqual([c0.appended, c0.noTime], [0, 1]);
  // a claim stamped with a run's time (as before) is re-dated once, as a correction, then left alone
  await x.store.appendRecord(D, { t: 'claim', kind: 'fact', key: 'card.syn-v.status', text: 'Card SYN-V status: done' }, 'derived-internal');
  const f = { slot: 'card.syn-v.status', key: 'card.syn-v.status', kind: 'fact', text: 'Card SYN-V status: done', at: '2026-09-01T00:00:00.000Z', refs: [] };
  const c1 = await W.syncDerived(x.deps, [f]);
  assert.deepEqual([c1.appended, c1.redated, c1.older ?? 0], [1, 1, 0]);
  const v = x.live().find((c) => c.key === 'card.syn-v.status');
  assert.equal(v.at, '2026-09-01T00:00:00.000Z');
  assert.deepEqual(v.supersedesReason, { category: 'corrected', note: 'valid time' });
  assert.equal((await W.syncDerived(x.deps, [f])).unchanged, 1, 'idempotent');
  // a time after the write time is stored clamped (F2) and still counts as unchanged
  const fut = { ...f, slot: 'card.syn-v.assignee', key: 'card.syn-v.assignee', text: 'Card SYN-V has no assignee', at: '2999-01-01T00:00:00.000Z' };
  assert.equal((await W.syncDerived(x.deps, [fut])).appended, 1);
  assert.equal((await W.syncDerived(x.deps, [fut])).unchanged, 1);
  // the sources: status-since (task-meta), the archive row, the card stamps; never the run time
  fs.writeFileSync(path.join(x.root, 'tasks.json'), JSON.stringify({ tasks: [
    { id: 'SYN-V1', status: 'doing', assignee: 'a', createdAt: '2026-09-01T00:00:00Z', startedAt: '2026-09-02T00:00:00Z' },
    { id: 'SYN-V2', status: 'blocked', assignee: 'a', createdAt: '2026-09-01T00:00:00Z' },
    { id: 'SYN-V3', status: 'todo' },
  ] }));
  fs.mkdirSync(path.join(x.root, 'state'), { recursive: true });
  fs.writeFileSync(path.join(x.root, 'state', 'task-meta.json'), JSON.stringify({ v: 1, cards: {
    'SYN-V1': { status: 'doing', statusSince: Date.parse('2026-09-03T00:00:00Z'), lastEditAt: Date.parse('2026-09-04T00:00:00Z') },
    'SYN-V2': { status: 'todo', statusSince: Date.parse('2026-09-05T00:00:00Z') },
  } }));
  fs.mkdirSync(path.join(x.root, 'tasks-archive'), { recursive: true });
  fs.writeFileSync(path.join(x.root, 'tasks-archive', '2026-09.jsonl'), `${JSON.stringify({ at: '2026-09-06T00:00:00Z', card: { id: 'SYN-V4', status: 'done', assignee: 'b' } })}\n`);
  const cards = W.readCards(x.root);
  const at = Object.fromEntries((await F.cardFieldFacts(cards, null)).map((f0) => [f0.key, f0.at]));
  assert.equal(at['card.syn-v1.status'], '2026-09-03T00:00:00.000Z', 'status-since from the harness record');
  assert.equal(at['card.syn-v1.assignee'], '2026-09-04T00:00:00.000Z', 'the last edit');
  assert.equal(at['card.syn-v2.status'], '2026-09-01T00:00:00.000Z', 'a status-since for another status is not used');
  assert.equal(at['card.syn-v3.status'], undefined, 'no time at all: none (not written)');
  assert.equal(at['card.syn-v4.status'], '2026-09-06T00:00:00.000Z', 'an archived card: its archive row');
  assert.equal(F.statusAt({ status: 'done', doneAt: '2026-09-07T00:00:00Z', createdAt: '2026-09-01T00:00:00Z' }), '2026-09-07T00:00:00.000Z');
  assert.equal(F.statusAt({ status: 'done', createdAt: '2026-09-01T00:00:00Z' }), '2026-09-01T00:00:00.000Z', 'only the record time is left');
  assert.equal(F.statusAt({ status: 'todo', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z' }), '2026-09-01T00:00:00.000Z', 'todo since creation');
  const rel = F.releaseFacts([{ version: '9.1.3', date: '2026-09-08', entries: [{ heading: 'Fixed', text: 'x' }] }], []);
  assert.deepEqual(rel.map((f0) => f0.at), ['2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z'], 'no tag: the CHANGELOG section date');
  const dec = F.decisionFacts([{ id: 'SYN-V5', humanQA: [{ q: 'Go?', a: 'Yes', askedAt: '2026-09-09T00:00:00Z' }] }]);
  assert.equal(dec[0].at, '2026-09-09T00:00:00.000Z', 'no answer time: the question time');
});

test('gate v2.4 step 1 (Jim a6ae9d): trusted links only, the subject @sha, the bump commit, fixVersion, plain CHANGELOG text', async () => {
  // F1: a mention-body index row never gives a done mail its card (CLAIMS-WEAKLINK-DONESHA: the mail is read
  // with its body but with no card and no linked cards, for git to confirm); a reply row gives linked cards, not the field.
  const x = setup();
  const dir = path.join(x.root, 'state', 'mail-cards');
  fs.mkdirSync(dir, { recursive: true });
  const row = (o) => JSON.stringify({ v: 1, act: 'done', trust: 'two-party', to: 'god', bodyHash: mailBodyHash(o.body ?? ''), ...o });
  fs.writeFileSync(path.join(dir, 'syn-f1.jsonl'), [
    row({ id: 'm-f1', card: 'SYN-F1', cards: ['SYN-F1'], cardFrom: 'mention-body', from: 'agent-x', subject: 'other work', body: 'like SYN-F1 at aaaaaa1' }),
    row({ id: 'm-f2', card: 'SYN-F1', cards: ['SYN-F1'], cardFrom: 'reply', from: 'agent-x', subject: 'sweep', body: 'bbbbbb2' }),
    row({ id: 'm-f3', card: 'SYN-F1', cards: ['SYN-F1'], cardFrom: 'mention-subject', from: 'agent-y', subject: 'SYN-F1 shipped', body: 'cccccc3' }),
  ].join('\n'));
  const mails = W.readDoneMails(x.root);
  assert.deepEqual(mails.map((m) => [m.id, m.card ?? null, JSON.stringify(m.cards ?? null), typeof m.body]), [['m-f1', null, 'null', 'string'], ['m-f2', null, '["SYN-F1"]', 'string'], ['m-f3', null, '["SYN-F1"]', 'string']]);
  // F2: the subject's @sha is the mail's sha, preferred over body commits and kept when git lacks it.
  const g = fakeGit({ commits: { aaaaaa1: H('a'), bbbbbb2: H('b'), '58102304': H('5') }, parents: { [H('b')]: [H('a')] }, time: {} });
  const r = await F.doneMailFacts([
    { id: 'm1', act: 'done', from: 'agent-x', card: 'SYN-F2', subject: 'SYN-F2 @aaaaaa1', body: 'on base bbbbbb2', created_at: '2026-10-01T00:00:00Z' },
    { id: 'm2', act: 'done', from: 'agent-y', card: 'SYN-F2', subject: 'SYN-F2 @fedcba98', body: 'no other sha', created_at: '2026-10-01T00:00:00Z' },
    { id: 'm3', act: 'done', from: 'agent-z', card: 'SYN-F2', subject: 'SYN-F2 @58102304', created_at: '2026-10-01T00:00:00Z' },
  ], ['SYN-F2'], g);
  const by = Object.fromEntries(r.facts.map((f) => [f.slot, f]));
  assert.match(by['card.syn-f2.donesha#agent-x'].text, new RegExp(`names commit aaaaaaaa \\(${H('a')}\\) as its subject's @sha$`), 'not the later body commit');
  assert.match(by['card.syn-f2.donesha#agent-y'].text, /names commit fedcba98 \(fedcba98\) as its subject's @sha \(not in the repository\)$/);
  assert.deepEqual(by['card.syn-f2.donesha#agent-y'].refs.map((y) => y.type), ['task', 'msg'], 'no commit ref for a sha the repository lacks');
  assert.equal(by['card.syn-f2.donesha#agent-z'].refs[2].value, H('5'), 'a digit-only @sha');
  assert.deepEqual(F.subjectAtShas('CARD-1 @1A2B3C4D done'), [{ sha: '1a2b3c4d', name: 'card-1' }]);
  assert.deepEqual(F.subjectAtShas('mail me@abcdef12'), [], 'part of a word');
  assert.deepEqual(F.subjectAtShas('on origin: guppy/X-1 @aaaaaa1, (Y-2: @bbbbbb2) and @aaaaaa1'), [{ sha: 'aaaaaa1', name: 'guppy/x-1' }, { sha: 'bbbbbb2', name: 'y-2' }], 'once each, the word before it');
  // Several subject @shas (god ab86be, Jim b3803c DV007): an ancestry chain gives its descendant,
  // whatever order the subject writes them in.
  const two = await F.doneMailFacts([
    { id: 'm6', act: 'done', from: 'agent-w', card: 'SYN-F2', subject: 'SYN-F2 PASS @aaaaaa1, NIT folded @bbbbbb2', created_at: '2026-10-01T00:00:00Z' },
    { id: 'm7', act: 'done', from: 'agent-v', card: 'SYN-F2', subject: 'SYN-F2 @bbbbbb2 re-checked on @aaaaaa1', created_at: '2026-10-01T00:00:00Z' },
  ], ['SYN-F2'], g);
  const tw = Object.fromEntries(two.facts.map((f) => [f.slot, f]));
  assert.equal(tw['card.syn-f2.donesha#agent-w'].refs[2].value, H('b'), 'chain: the descendant, written last');
  assert.equal(tw['card.syn-f2.donesha#agent-v'].refs[2].value, H('b'), 'chain: the descendant, written first');
  // Unrelated shas: the one written next to this card's id or branch name; none or both: ambiguous,
  // no claim from that mail (the sender's previous done mail stands).
  const gu = fakeGit({ commits: { aaaaaa1: H('a'), cccccc3: H('c'), dddddd4: H('d') }, parents: {}, time: { [H('c')]: 300, [H('d')]: 100 } });
  const un = await F.doneMailFacts([
    { id: 'u1', act: 'done', from: 'agent-u', card: 'SYN-F2', subject: 'Both on origin: guppy/syn-other @cccccc3 and guppy/syn-f2 @dddddd4', created_at: '2026-10-01T00:00:00Z' },
    { id: 'u2', act: 'done', from: 'agent-t', card: 'SYN-F2', subject: 'SYN-F2 @dddddd4, SYN-OTHER @cccccc3', created_at: '2026-10-01T00:00:00Z' },
    { id: 'u3', act: 'done', from: 'agent-s', card: 'SYN-F2', subject: 'SYN-F2 @aaaaaa1', created_at: '2026-10-01T00:00:00Z' },
    { id: 'u4', act: 'done', from: 'agent-s', card: 'SYN-F2', subject: 'PASS @cccccc3, NIT @dddddd4', created_at: '2026-10-02T00:00:00Z' },
    { id: 'u5', act: 'done', from: 'agent-r', card: 'SYN-F2', subject: 'syn-f2 @cccccc3 and syn-f2 @dddddd4', created_at: '2026-10-02T00:00:00Z' },
    { id: 'u6', act: 'done', from: 'agent-q', card: 'SYN-F2', subject: 'SYN-F2 @aaaaaa1 on base @fedcba98', created_at: '2026-10-02T00:00:00Z' },
  ], ['SYN-F2', 'SYN-OTHER'], gu);
  const ub = Object.fromEntries(un.facts.map((f) => [f.slot, f]));
  assert.equal(ub['card.syn-f2.donesha#agent-u'].refs[2].value, H('d'), "unrelated: this card's branch name, written second (DV007)");
  assert.equal(ub['card.syn-f2.donesha#agent-t'].refs[2].value, H('d'), "unrelated: this card's id, written first");
  assert.equal(ub['card.syn-f2.donesha#agent-s'].refs[2].value, H('a'), 'unrelated, no name next to either: u4 skipped, u3 stands');
  assert.equal(ub['card.syn-f2.donesha#agent-q'].refs[2].value, H('a'), 'a sha the repository lacks is no chain; the card name settles it');
  assert.equal(ub['card.syn-f2.donesha#agent-r'], undefined, 'both next to the card: ambiguous');
  assert.deepEqual(un.skips.filter((s) => s.reason === 'ambiguous'), [{ mail: 'u4', reason: 'ambiguous', cards: ['SYN-F2'] }, { mail: 'u5', reason: 'ambiguous', cards: ['SYN-F2'] }]);
  // lastsha: a digit-only @sha in the card record counts (it is the descendant here).
  const lf = await F.cardFieldFacts([{ id: 'SYN-F5', status: 'done', createdAt: '2026-10-01T00:00:00Z', result: 'merged bbbbbb2; then mutants @58102304 (off bbbbbb2)' }],
    fakeGit({ commits: { bbbbbb2: H('b'), '58102304': H('5') }, parents: { [H('5')]: [H('b')] }, time: { [H('5')]: 1 } }));
  assert.match(lf.find((f) => f.key === 'card.syn-f5.lastsha').text, new RegExp(`${H('5')}\\)$`));
  // F4: fixVersion like status and assignee.
  const ff = await F.cardFieldFacts([{ id: 'SYN-F4', status: 'blocked', fixVersion: '1.1.97', updatedAt: '2026-10-02T00:00:00Z' }, { id: 'SYN-F6', status: 'todo', createdAt: '2026-10-02T00:00:00Z' }], null);
  const fv = Object.fromEntries(ff.map((f) => [f.key, f]));
  assert.equal(fv['card.syn-f4.fixversion'].text, 'Card SYN-F4 fix version: 1.1.97');
  assert.equal(fv['card.syn-f4.fixversion'].at, '2026-10-02T00:00:00.000Z');
  assert.equal(fv['card.syn-f6.fixversion'].text, 'Card SYN-F6 has no fix version');
  // F3: the bump commit is the first commit that sets package.json "version" to V (not the tag commit).
  const rp = makeRepo();
  rp.commit('start', '2026-10-01T10:00:00Z', 'package.json', '{\n  "name": "x",\n  "version": "9.1.1"\n}\n');
  const bump = rp.commit('9.1.2: bump', '2026-10-02T10:00:00Z', 'package.json', '{\n  "name": "x",\n  "version": "9.1.2"\n}\n');
  const tagged = rp.commit('9.1.2: docs', '2026-10-03T10:00:00Z');
  rp.g(['tag', 'v9.1.2']);
  rp.commit('try 9.1.3', '2026-10-04T10:00:00Z', 'package.json', '{\n  "name": "x",\n  "version": "9.1.3"\n}\n');
  rp.commit('back to 9.1.2', '2026-10-05T10:00:00Z', 'package.json', '{\n  "name": "x",\n  "version": "9.1.2"\n}\n');
  const dg = new DerivedGit(rp.repo);
  const bumps = await dg.bumps();
  assert.equal(bumps.get('9.1.2').commit, bump);
  assert.equal(bumps.get('9.1.1').commit, rp.g(['rev-list', '--max-parents=0', 'HEAD']));
  const rel = Object.fromEntries(F.releaseFacts([{ version: '9.1.2', date: '2026-10-03', headline: '**Bold** and `code`', entries: [{ heading: 'Fixed', text: '**Lead.** Uses `memory search --exact`.' }] }], await dg.tags(), bumps).map((f) => [f.key, f]));
  assert.match(rel['release.9.1.2'].text, new RegExp(`tag v9\\.1\\.2 is commit ${tagged} \\(tagged 2026-10-03\\), version bump commit ${bump}\\. Bold and code$`));
  assert.deepEqual(rel['release.9.1.2'].refs, [{ type: 'commit', value: tagged }, { type: 'commit', value: bump }]);
  assert.equal(rel['release.9.1.2.bump'].text, `Guppy 9.1.2 version bump: the first commit that sets package.json version to 9.1.2 is ${bump.slice(0, 8)} (${bump})`);
  assert.equal(rel['release.9.1.2.bump'].at, '2026-10-02T10:00:00.000Z');
  assert.equal(rel['release.9.1.2.e1'].text, 'Guppy 9.1.2 (2026-10-03) CHANGELOG Fixed: Lead. Uses memory search --exact.', 'no markup');
});

test('merge class (god c33130): a merge into an INT gives card.<id>.merge when a card owns the branch, else branch.<name>; latest wins', async () => {
  const g = fakeGit({ commits: { aaaaaa1: H('a'), bbbbbb2: H('b'), dddddd4: H('d'), [H('t')]: H('t') }, parents: {}, time: {} });
  const log = [
    { commit: H('1'), time: 100, message: 'Merge guppy/syn-m1 @aaaaaa1 into int-9.1.2 (Jim PASS)\n\nbody' },
    { commit: H('2'), time: 200, message: 'Merge guppy/syn-m1 @bbbbbb2 into int-9.1.2 (Jim PASS, X9 pin)' },
    { commit: H('3'), time: 150, message: 'Merge guppy/Lone-Branch (cccccc3) into int/release-9.1.1: notes' },
    { commit: H('4'), time: 160, message: 'Merge guppy/no-sha into int-9.1.3', parents: [H('x'), H('t')] },
    { commit: H('5'), time: 170, message: 'Merge origin/main into integration/v0.4.5' },
    { commit: H('6'), time: 180, message: 'Merge SYN-M2 dddddd4 into INT 9.1.2 stage 3' },
    { commit: H('7'), time: 190, message: 'Merge guppy/no-parent into int-9.1.3', parents: [H('x')] },
    { commit: H('8'), time: 300, message: 'SYN-M1: Merge guppy/syn-m1 @aaaaaa1 into int-9.1.2 (not a merge subject)' },
  ];
  const facts = await F.mergeFacts(log, ['SYN-M1', 'SYN-M2', 'INT-9.1.2'], g);
  const by = Object.fromEntries(facts.map((f) => [f.key, f]));
  assert.deepEqual(Object.keys(by), ['branch.lone-branch', 'branch.no-sha', 'card.syn-m1.merge', 'card.syn-m2.merge']);
  assert.equal(by['card.syn-m1.merge'].text, `Card SYN-M1: branch guppy/syn-m1 was last merged into INT-9.1.2 at tip bbbbbbbb (${H('b')}) by merge commit 22222222 (${H('2')})`);
  assert.deepEqual(by['card.syn-m1.merge'].refs, [{ type: 'task', value: 'SYN-M1' }, { type: 'task', value: 'INT-9.1.2' }, { type: 'commit', value: H('b') }, { type: 'commit', value: H('2') }]);
  assert.equal(by['card.syn-m1.merge'].at, new Date(200000).toISOString());
  assert.equal(by['branch.lone-branch'].text, `Branch guppy/Lone-Branch was last merged into INT-9.1.1 at tip cccccc3 (cccccc3, not in the repository) by merge commit 33333333 (${H('3')})`);
  assert.deepEqual(by['branch.lone-branch'].refs, [{ type: 'commit', value: H('3') }]);
  assert.equal(by['branch.no-sha'].refs[0].value, H('t'), 'no sha in the subject: the second parent');
  assert.match(by['card.syn-m2.merge'].text, /^Card SYN-M2: branch SYN-M2 was last merged into INT-9.1.2 at tip dddddddd/);
});

test('merge class (god 0b71e3): every INT target form git history uses, both subject forms; the value is the tip into int-<v>', async () => {
  const S = (s) => F.mergeSubject(s);
  assert.deepEqual(S('Merge guppy/syn-a @a1b2c3d into int-9.1.2 (Jim PASS)'), { ref: 'guppy/syn-a', sha: 'a1b2c3d', int: 'int-9.1.2', single: true });
  assert.equal(S('Merge guppy/syn-b (b1b2c3d) into int/release-9.1.3: notes').int, 'int-9.1.3');
  assert.equal(S('Merge SYN-C c1c2c3d into INT 9.1.4 stage 3').int, 'int-9.1.4');
  assert.deepEqual(S('Merge origin/guppy/syn-d into 9.1.5'), { ref: 'origin/guppy/syn-d', int: 'int-9.1.5', single: true }, 'a bare version; no sha');
  assert.equal(S('Merge guppy/syn-e @e1e2e3d into origin/guppy/int-9.1.6').int, 'int-9.1.6', 'origin/ and guppy/ before the target');
  assert.deepEqual(S('INT 9.1.7: merge SYN-F @f1f2f3d'), { ref: 'SYN-F', sha: 'f1f2f3d', int: 'int-9.1.7', single: true }, 'the line form');
  assert.deepEqual(S('INT-9.1.8 stage 12: merge syn-g fix-up @a9a9a9a; glob 1'), { ref: 'syn-g', sha: 'a9a9a9a', int: 'int-9.1.8', single: false }, 'line form, a stage, free words');
  assert.deepEqual(S('Merge guppy SYN-H @d4d4d4d into int-9.1.9'), { ref: 'SYN-H', sha: 'd4d4d4d', int: 'int-9.1.9', single: true });
  assert.deepEqual(S('Merge SYN-I step 3 a7a7a7a (pin) into INT 9.2.2 stage 17'), { ref: 'SYN-I', int: 'int-9.2.2', single: false }, 'free words: no sha taken, the tip is the second parent');
  assert.equal(S('Merge build leftovers username into 9.2.0').single, false);
  assert.deepEqual(S('rc/9.1.1: merge x @abc1234 (Jim PASS)'), { ref: 'x', sha: 'abc1234', int: 'rc-9.1.1', single: true }, 'rc keeps its own target (god d77de8)');
  assert.equal(S('Merge guppy/x @a1b2c3d into rc/9.1.1').int, 'rc-9.1.1', 'never int');
  for (const s of ['Merge release-9.1.1 @41120b14 into int: notes', 'Merge guppy/x into release-9.1.1', 'Merge x into the 9.1.1 line', 'Merge guppy/x into main', 'Merge a into b (folded into 9.1.1)']) assert.equal(S(s), null, s);
  const g = fakeGit({ commits: { a1b2c3d: H('a'), f1f2f3d: H('f') }, parents: {}, time: {} });
  const log = [
    { commit: H('1'), time: 100, message: 'Merge guppy/syn-a @a1b2c3d into int-9.1.2' },
    { commit: H('2'), time: 110, message: 'Merge origin/guppy/syn-d into 9.1.5', parents: [H('x'), H('d')] },
    { commit: H('3'), time: 120, message: 'INT 9.1.7: merge SYN-F @f1f2f3d' },
    { commit: H('4'), time: 130, message: 'Merge guppy/lone @e1e2e3d into origin/guppy/int-9.1.6' },
    { commit: H('5'), time: 140, message: 'Merge build leftovers username into 9.2.0', parents: [H('x'), H('b')] },
    { commit: H('6'), time: 150, message: "Merge commit 'c3c3c3c' into guppy/int-9.2.1" },
    { commit: H('7'), time: 160, message: 'Merge SYN-I step 3 a7a7a7a (pin) into INT 9.2.2 stage 17', parents: [H('x'), H('9')] },
    { commit: H('8'), time: 170, message: 'rc/9.0.7: merge rc-only @b9b9b9b (Jim PASS)' },
    { commit: H('c'), time: 180, message: 'rc/9.1.2: merge SYN-A @c1c2c3d' },
    { commit: H('e'), time: 190, message: 'Merge guppy/lone @d1d2d3d into rc/9.1.6' },
  ];
  const facts = await F.mergeFacts(log, ['SYN-A', 'SYN-D', 'SYN-F', 'SYN-I'], g);
  const by = Object.fromEntries(facts.map((f) => [f.key, f.value]));
  assert.deepEqual(by, {
    'branch.lone': 'e1e2e3d into int-9.1.6',
    'branch.lone.rc': 'd1d2d3d into rc-9.1.6',
    'branch.rc-only.rc': 'b9b9b9b into rc-9.0.7',
    'card.syn-a.merge': `${H('a')} into int-9.1.2`,
    'card.syn-a.merge.rc': 'c1c2c3d into rc-9.1.2',
    'card.syn-d.merge': `${H('d')} into int-9.1.5`,
    'card.syn-f.merge': `${H('f')} into int-9.1.7`,
    'card.syn-i.merge': `${H('9')} into int-9.2.2`,
  }, 'a free-worded ref or a bare commit names no branch; a later rc merge leaves the INT merge current (god 234b13)');
});

// ———————————————————————————————————————————————————— CLAIMS-90 L1/L4 (god 69bc66): the structured value

test('CLAIMS-90 L1: value and valueAgent are written by the derived writer only, one line, at most 120 characters', async () => {
  const { CLAIM_VALUE_MAX } = loadTs('src/shared/claims.ts');
  assert.equal(CLAIM_VALUE_MAX, 120);
  const x = setup();
  const ok = await x.store.appendRecord(D, fact('synthetic status fact', { key: 'card.syn-v.status', value: 'done' }), 'derived-internal');
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(x.claims()[0].value, 'done', 'stored beside the text');
  const two = await x.store.appendRecord(D, fact('synthetic done fact', { key: 'card.syn-v.donesha', value: H('a'), valueAgent: 'agent-x' }), 'derived-internal');
  assert.equal(two.ok, true, JSON.stringify(two));
  assert.deepEqual([x.claims()[1].value, x.claims()[1].valueAgent], [H('a'), 'agent-x']);
  for (const origin of ['endpoint', 'ledger-route', 'ui-ipc', 'w6-internal']) for (const fld of ['value', 'valueAgent']) {
    const r = await x.store.appendRecord('a1', fact(`agent ${fld} via ${origin}`, { [fld]: 'x' }), origin);
    assert.equal(r.ok, false, `${origin} ${fld}`);
  }
  const r = await x.store.appendRecord('a1', fact('agent value', { value: 'x' }), 'endpoint');
  assert.match(r.error, /value is set by the derived writer only/);
  for (const bad of ['two\nlines', 'x'.repeat(121), '', '  ', 7]) {
    const b = await x.store.appendRecord(D, fact('synthetic bad value', { key: 'card.syn-v.lastsha', value: bad }), 'derived-internal');
    assert.equal(b.ok, false, JSON.stringify(bad));
  }
  assert.equal(x.claims().length, 2);
  const { tombstone } = loadTs('src/main/claims/store.ts');
  const t = tombstone(x.claims()[1]);
  assert.equal('value' in t || 'valueAgent' in t, false, 'a purge drops the value with the text');
  const ep = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'claims', 'endpoint.ts'), 'utf8');
  assert.match(ep, /const FORBIDDEN = new Set\(\[[^\]]*'value', 'valueAgent'/, 'a request may not carry them');
});

test('CLAIMS-90 L4: the audit verdict is the newest dated entry naming an audit with PASS|FAIL @sha; the last verdict within it', () => {
  const card = (result, notes) => ({ id: 'SYN-AU', result, notes });
  assert.equal(F.auditVerdict(card('', '')), null);
  assert.equal(F.auditVerdict(card('', 'AUDIT PASS @1234abcd (no date)')), null, 'an undated line is no entry');
  assert.equal(F.auditVerdict(card('', '[2026-10-01] PASS @1234abcd shipped')), null, 'no audit word: not an audit verdict');
  assert.equal(F.auditVerdict(card('', '[2026-10-01] AUDIT PASS 1234abcd')), null, 'the commit is written @<sha>');
  assert.deepEqual(F.auditVerdict(card('', '[2026-10-01] AUDIT FAIL @1234abcd\n[2026-10-03] re-audit PASS @5678ABCD after the fix\n[2026-10-02] audit FAIL @9999eeee')),
    { verdict: 'PASS', sha: '5678abcd', at: '2026-10-03T00:00:00.000Z' }, 'newest by date, not by place; lower-cased');
  assert.deepEqual(F.auditVerdict(card('[2026-10-05T10:00:00Z] Jim audit FAIL @1111aaaa, then RECHECK PASS @2222bbbb', '[2026-10-04] AUDIT PASS @3333cccc')),
    { verdict: 'PASS', sha: '2222bbbb', at: '2026-10-05T10:00:00.000Z' }, 'the result counts; within an entry the last verdict');
  assert.deepEqual(F.auditVerdict(card('', '[2026-10-01] AUDIT PASS @1234abcd\n[2026-10-01] AUDIT FAIL @5678abcd')).verdict, 'FAIL', 'a tie: the later one written');
});

test('CLAIMS-90 L1/L4: every field fact carries its value; audit and tag are their own fields', async () => {
  const A = 'a1'.repeat(20), B = 'b2'.repeat(20);
  const git = fakeGit({ commits: { a1a1a1a1: A, [A]: A, b2b2b2b2: B, [B]: B }, parents: { [B]: [A] }, time: { [A]: 100, [B]: 200 } });
  const cards = [
    { id: 'SYN-F1', title: 'T', status: 'done', assignee: 'agent-x', fixVersion: '9.1.2', result: 'landed @a1a1a1a1', notes: '[2026-10-02] audit PASS @b2b2b2b2', updatedAt: '2026-10-02T00:00:00Z' },
    { id: 'SYN-F2', status: 'todo', createdAt: '2026-10-01T00:00:00Z' },
  ];
  const by = Object.fromEntries((await F.cardFieldFacts(cards, git)).map((x) => [x.key, x]));
  assert.equal(by['card.syn-f1.status'].value, 'done');
  assert.equal(by['card.syn-f1.assignee'].value, 'agent-x');
  assert.equal(by['card.syn-f1.fixversion'].value, '9.1.2');
  assert.equal(by['card.syn-f1.lastsha'].value, B);
  assert.equal(by['card.syn-f1.audit'].value, `PASS ${B}`, 'the verdict, one space, the full commit');
  assert.equal(by['card.syn-f1.audit'].at, '2026-10-02T00:00:00.000Z', 'dated by its entry');
  assert.match(by['card.syn-f1.audit'].text, /latest audit verdict .*: PASS at commit b2b2b2b2/);
  assert.deepEqual([by['card.syn-f2.assignee'].value, by['card.syn-f2.fixversion'].value], ['none', 'none']);
  assert.equal(by['card.syn-f2.audit'], undefined);
  const nogit = Object.fromEntries((await F.cardFieldFacts(cards, null)).map((x) => [x.key, x]));
  assert.equal(nogit['card.syn-f1.audit'].value, 'PASS b2b2b2b2', 'without git the sha as written');
  const rel = Object.fromEntries(F.releaseFacts([{ version: '9.1.2', date: '2026-10-03', entries: [{ heading: 'Fixed', text: 'x' }] }], [{ name: 'v9.1.2', commit: A, date: '2026-10-03T00:00:00Z' }], new Map([['9.1.2', { commit: B, time: 100 }]])).map((x) => [x.key, x]));
  assert.equal(rel['release.9.1.2.tag'].value, A);
  assert.match(rel['release.9.1.2.tag'].text, /release tag v9\.1\.2 is commit a1a1a1a1/);
  assert.equal(rel['release.9.1.2.bump'].value, B);
  for (const k of ['release.9.1.2', 'release.9.1.2.e1']) assert.equal(rel[k].value, undefined, `${k} is prose`);
  const gh = await F.gitHistoryFacts([{ commit: A, time: 100, message: 'SYN-F1 x' }], ['SYN-F1'], git);
  assert.equal(gh[0].value, A);
  const mg = await F.mergeFacts([{ commit: B, time: 200, message: 'Merge branch guppy/syn-f1 @a1a1a1a1 into int-9.1.2' }], ['SYN-F1'], git);
  assert.deepEqual([mg[0].key, mg[0].value], ['card.syn-f1.merge', `${A} into int-9.1.2`], 'the merged tip and its INT target');
});

test('CLAIMS-90 L1: R2 never undoes an explicit supersedes when the replacement shares the valid and write time of its target', () => {
  const reg = { v: 1, namespaces: [{ pattern: 'single.*', cardinality: 'single' }], keys: {} };
  const at = '2026-10-01T00:00:00.000Z';
  const rec = (id, extra = {}) => ({ v: 1, id, t: 'claim', kind: 'fact', key: 'single.k', text: id, source: 'derived', at, wt: at, agent: D, mac: `m-${id}`, prev: '', ...extra });
  // ids are ordered so that the target sorts after its replacement on the id tie-break
  const s = derive([rec('c-z-old'), rec('c-a-new', { supersedes: ['c-z-old'] })], reg, { r4: false });
  assert.equal(s.claims['c-a-new'].status, 'live', 'the replacement stays live');
  assert.equal(s.claims['c-z-old'].status, 'superseded');
  assert.equal(s.claims['c-z-old'].supersededBy, 'c-a-new');
  // R2 order is mid, top, base: the claim right after the newest replacement is one it supersedes only through mid
  const chain = derive([rec('c-c-base'), rec('c-a-mid', { supersedes: ['c-c-base'] }), rec('c-b-top', { supersedes: ['c-a-mid'] })], reg, { r4: false });
  assert.deepEqual(['c-c-base', 'c-a-mid', 'c-b-top'].map((id) => chain.claims[id].status), ['superseded', 'superseded', 'live'], 'transitively too');
  const mail = derive([rec('c-z-own'), rec('c-a-mail', { source: 'mail:m1', supersedes: ['c-z-own'] })], reg, { r4: false });
  assert.equal(mail.claims['c-z-own'].status, 'live', 'a mail supersedes of a derived claim still has no effect');
  assert.equal(mail.claims['c-a-mail'].status, 'superseded', 'and so earns no exemption from R2');
});

test('CLAIMS-90 L1 backfill: a live field claim without a value is superseded once by the same fact with it (corrected, structured value)', async () => {
  const x = setup();
  const at = '2026-10-01T00:00:00.000Z';
  const old = { slot: 'card.syn-b.status', key: 'card.syn-b.status', kind: 'fact', text: 'Card SYN-B status: done', at, refs: [{ type: 'task', value: 'SYN-B' }] };
  assert.equal((await W.syncDerived(x.deps, [old])).appended, 1);
  assert.equal(x.live()[0].value, undefined, 'an older claim, written before values');
  const withValue = { ...old, value: 'done' };
  const c = await W.syncDerived(x.deps, [withValue]);
  assert.deepEqual([c.appended, c.superseded, c.valued, c.unchanged, c.redated], [1, 1, 1, 0, undefined]);
  const live = x.live();
  assert.equal(live.length, 1);
  assert.equal(live[0].value, 'done');
  assert.deepEqual(live[0].supersedesReason, { category: 'corrected', note: 'structured value' });
  assert.equal((await W.syncDerived(x.deps, [withValue])).unchanged, 1, 'a second sync appends nothing');
  const moved = await W.syncDerived(x.deps, [{ ...withValue, value: 'doing', text: 'Card SYN-B status: doing', at: '2026-10-02T00:00:00.000Z' }]);
  assert.deepEqual([moved.appended, moved.valued], [1, undefined], 'a changed value is a change, not a backfill');
  assert.equal(x.live()[0].supersedesReason.category, 'changed');
});
