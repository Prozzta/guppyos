'use strict';
/**
 * REQUESTS-TAB-STALE (1.1.83): an open request closes when its work is provably finished, not only
 * on a routed reply or the Human's close. The rule (mailLedger.staleObligations), over a real
 * (jailed) hive (HiveManager.autoCloseStaleObligations), and the wiring (a main beat, data only).
 *  - the card(s) its subject names are all done; or
 *  - its recipient later sent the requester a done/inform/agree/refuse in the same conversation; or
 *  - its subject opens with a release that has shipped (the running version or later).
 * Never by age alone; every auto-close logs its reason; nothing wakes and no mail is written.
 * HOME, USERPROFILE, CODEX_HOME and GEMINI_CLI_HOME are jailed and asserted first.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-requests-stale-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL; process.env.CODEX_HOME = path.join(JAIL, '.codex'); process.env.GEMINI_CLI_HOME = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const { staleObligations } = loadTs('src/main/mailLedger.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { readSource, codeOnly } = require('./read-source.cjs');

const H = 3600_000;
let seq = 0;
function entry(o) {
  seq++;
  return { id: o.id ?? `m${seq}`, from: o.from, act: o.act ?? 'request', subject: o.subject ?? 'x', conversation: o.conversation,
    bodyHash: null, via: 'inbox', state: o.state ?? 'acted', seq, deliveredAt: o.at ?? seq, surfaceCount: 1, unconfirmedSurfacings: 0,
    redelivered: false, legacy: false, requiresReply: o.requiresReply ?? (o.act ?? 'request') === 'request',
    repliedAt: o.repliedAt ?? null, closedAt: o.closedAt ?? null, updatedAt: o.at ?? seq };
}
function doc(agentId, ...entries) {
  return { version: 1, agentId, nextSeq: entries.length + 1, lastActivityAt: null, lastActedAt: null, entries: Object.fromEntries(entries.map((e) => [e.id, e])) };
}
const reasons = (list) => Object.fromEntries(list.map((s) => [s.id, s.reason]));

test('card rule: closes only when every card the subject names exists and is done', () => {
  const cards = new Map([['ALPHA-1', 'done'], ['BETA-TWO', 'doing'], ['GAMMA-3', 'done']]);
  const docs = { andy: doc('andy',
    entry({ id: 'a', from: 'god', subject: 'ALPHA-1: fix the thing' }),
    entry({ id: 'b', from: 'god', subject: 'ALPHA-1 then BETA-TWO' }),
    entry({ id: 'c', from: 'god', subject: 'GAMMA-3 and ALPHA-1 (audit both)' }),
    entry({ id: 'd', from: 'god', subject: 'NOT-A-CARD is done' }),
    entry({ id: 'e', from: 'god', subject: 'alpha-1 lower case is not a card id' }),
    entry({ id: 'f', from: 'god', subject: 'XALPHA-1 is another id' })) };
  assert.deepEqual(reasons(staleObligations(docs, cards, null)), { a: 'auto:card-done:ALPHA-1', c: 'auto:card-done:GAMMA-3,ALPHA-1' });
});

test('conversation rule: a later done/inform/agree/refuse from the recipient, same conversation, back to the requester', () => {
  const ask = (id, conv, at) => entry({ id, from: 'god', subject: 'please do it', conversation: conv, at });
  const back = (act, conv, at, from = 'andy') => entry({ from, act, subject: 'about it', conversation: conv, at, requiresReply: false });
  const docs = {
    andy: doc('andy', ask('done1', 'c-done', 10), ask('inform1', 'c-inf', 10), ask('agree1', 'c-agr', 10), ask('refuse1', 'c-ref', 10),
      ask('query1', 'c-q', 10), ask('req1', 'c-r', 10), ask('earlier1', 'c-early', 10), ask('other1', 'c-other', 10), ask('noconv', undefined, 10)),
    god: doc('god', back('done', 'c-done', 20), back('inform', 'c-inf', 20), back('agree', 'c-agr', 20), back('refuse', 'c-ref', 20),
      back('query', 'c-q', 20), back('request', 'c-r', 20), back('done', 'c-early', 5), back('done', 'c-other', 20, 'jim'), back('done', undefined, 20)),
  };
  const got = reasons(staleObligations(docs, new Map(), null));
  assert.deepEqual(Object.keys(got).sort(), ['agree1', 'done1', 'inform1', 'refuse1']);
  assert.match(got.done1, /^auto:answered:done:m\d+$/);
});

test('release rule: the subject opens with a release and the running version is that or later', () => {
  const docs = { jim: doc('jim',
    entry({ id: 'r82', from: 'god', subject: '1.1.82: audit the cut' }),
    entry({ id: 'rc80', from: 'god', subject: 'rc/1.1.80 row 5: merge it' }),
    entry({ id: 'v81', from: 'god', subject: 'v1.1.81 publish check' }),
    entry({ id: 'r83', from: 'god', subject: '1.1.83: build the next one' }),
    entry({ id: 'mid', from: 'god', subject: 'fix the 1.1.80 bug' }),
    entry({ id: 'long', from: 'god', subject: '1.1.820: not a prefix of 1.1.82' }),
    entry({ id: 'quad', from: 'god', subject: '1.1.80.1 hotfix' })) };
  assert.deepEqual(reasons(staleObligations(docs, new Map(), '1.1.82')),
    { r82: 'auto:release-shipped:1.1.82', rc80: 'auto:release-shipped:1.1.80', v81: 'auto:release-shipped:1.1.81' });
  assert.deepEqual(staleObligations(docs, new Map(), null), [], 'no running version, no release evidence');
  assert.deepEqual(Object.keys(reasons(staleObligations(docs, new Map(), '2.0.0'))).sort(), ['long', 'r82', 'r83', 'rc80', 'v81'], '1.1.820 is a release too');
});

test('never by age alone; replied, closed and non-obligations are left alone', () => {
  const old = Date.now() - 65 * H;
  const docs = { andy: doc('andy',
    entry({ id: 'dropped', from: 'god', subject: 'Review PR 12', at: old }),
    entry({ id: 'replied', from: 'god', subject: '1.1.80: x', repliedAt: 5 }),
    entry({ id: 'closed', from: 'god', subject: '1.1.80: y', closedAt: 5 }),
    entry({ id: 'fyi', from: 'god', act: 'inform', subject: '1.1.80: z', requiresReply: false }),
    entry({ id: 'query', from: 'god', act: 'query', subject: '1.1.80: still owed', requiresReply: true })) };
  assert.deepEqual(reasons(staleObligations(docs, new Map(), '1.1.82')), { query: 'auto:release-shipped:1.1.80' }, 'a requires_reply query is an obligation too');
});

test('replay: the live floor of 2026-10-03 (22 open, anonymised) keeps the 1.1.83 dispatches and 3 asks with no evidence', () => {
  const { isOpenObligation } = loadTs('src/main/mailLedger.ts');
  const f = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'requests-stale-183.json'), 'utf8'));
  const open = Object.entries(f.docs).flatMap(([a, d]) => Object.values(d.entries).filter(isOpenObligation).map((e) => `${a}/${e.id}`));
  assert.equal(open.length, 22);
  const closed = staleObligations(f.docs, new Map(Object.entries(f.cards)), f.shippedVersion);
  const gone = new Set(closed.map((s) => `${s.agentId}/${s.id}`));
  assert.deepEqual(open.filter((k) => !gone.has(k)).sort(), [
    // the live 1.1.83 dispatches: their cards are not done, 1.1.83 has not shipped, no answer yet
    'andy/2026-10-03T10-50-21-540Z-7d3555', 'creed/2026-10-03T10-50-21-754Z-1ffd35', 'jim/2026-10-03T10-50-21-106Z-642691',
    'jim/2026-10-03T10-58-11-180Z-fb90e1', 'jim/2026-10-03T11-04-20-453Z-50a3f6',
    // stale, but nothing proves it: these stay for the Human's close (no age-out)
    'creed/2026-10-03T08-57-53-890Z-6ccb84', 'dwight/2026-10-01T14-10-37-572Z-b97a1b', 'jim/2026-10-03T10-05-00-025Z-andy-pub182-jim',
  ].sort());
  const by = {};
  for (const s of closed) { const k = s.reason.split(':')[1]; by[k] = (by[k] || 0) + 1; }
  assert.deepEqual(by, { answered: 10, 'card-done': 4 });
});

async function floor(t) {
  const home = fs.mkdtempSync(path.join(JAIL, 'floor-'));
  const hive = new HiveManager(() => home, () => true);
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'andy-1', name: 'Andy', provider: 'claude', cwd: home });
  return { hive };
}
const inboxCount = (hive, id) => fs.readdirSync(path.join(hive.root(), 'agents', id, 'inbox')).filter((n) => n.endsWith('.json')).length;

test('hive: auto-closes by card and by conversation, logs each reason, writes no mail, is idempotent', async (t) => {
  const { hive } = await floor(t);
  hive.addTask({ id: 'SHIP-IT-1', title: 'ship', status: 'doing', dependsOn: [] });
  const byCard = hive.send({ to: 'andy-1', act: 'request', subject: 'SHIP-IT-1: build it', body: 'go' }, 'god-1');
  const byConv = hive.send({ to: 'andy-1', act: 'request', subject: 'Look at the logs', body: 'go', conversation: 'conv-logs' }, 'god-1');
  const live = hive.send({ to: 'andy-1', act: 'request', subject: 'Review PR 12', body: 'go', conversation: 'conv-pr' }, 'god-1');
  hive.send({ to: 'god-1', act: 'query', subject: 'which PR?', body: '?', conversation: 'conv-pr' }, 'andy-1');
  assert.deepEqual(hive.autoCloseStaleObligations('1.1.82'), [], 'nothing finished yet; a clarifying query answers nothing');

  hive.patchTask('SHIP-IT-1', { status: 'done' });
  hive.send({ to: 'god-1', act: 'inform', subject: 'logs are clean', body: 'done', conversation: 'conv-logs' }, 'andy-1');
  const before = ['god-1', 'andy-1'].map((id) => inboxCount(hive, id));
  const closed = hive.autoCloseStaleObligations('1.1.82');
  assert.deepEqual(closed.map((s) => s.id).sort(), [byCard.id, byConv.id].sort());
  assert.deepEqual(['god-1', 'andy-1'].map((id) => inboxCount(hive, id)), before, 'closing sends nothing to anyone');
  assert.deepEqual(hive.mailObligations().flatMap((a) => a.openRequests.map((o) => o.id)), [live.id], 'only the live ask is left');
  const rows = hive.logTail(500).filter((r) => r && r.kind === 'mail-obligation-closed');
  assert.deepEqual(rows.map((r) => [r.id, r.reason.replace(/:[^:]*$/, '')]).sort(),
    [[byCard.id, 'auto:card-done'], [byConv.id, 'auto:answered:inform']].sort());
  assert.deepEqual(hive.autoCloseStaleObligations('1.1.82'), [], 'idempotent');
});

test('WIRING: a main beat runs the sweep with the running version; only hive.ts auto-closes; the Human\'s close is unchanged', () => {
  const idx = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  assert.match(idx, /function runStaleRequestsBeat\(\): void \{\s*try \{ hive\.autoCloseStaleObligations\(app\.getVersion\(\)\); \}/);
  assert.match(idx, /function armAlwaysOnBeats\(\): void \{[\s\S]{0,900}if \(staleRequestsTimer\) clearInterval\(staleRequestsTimer\);\s*runStaleRequestsBeat\(\);\s*staleRequestsTimer = setInterval\(runStaleRequestsBeat, 60_000\);/);
  const hiveSrc = codeOnly(readSource('src/main/hive.ts'), 'hive.ts');
  assert.equal((hiveSrc.match(/\.autoCloseObligation\(/g) || []).length, 1);
  assert.equal((idx.match(/autoCloseObligation\(/g) || []).length, 0);
  assert.match(hiveSrc, /return this\.mail\.closeObligation\(agentId, id, 'closed-by-human'\);/);
});
