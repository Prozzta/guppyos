'use strict';
/**
 * REQUESTS-TAB-STALE (1.1.83): an open request closes when its work is provably finished, not only
 * on a routed reply or the Human's close. The rule (mailLedger.staleObligations), over a real
 * (jailed) hive (HiveManager.autoCloseStaleObligations), and the wiring (a packaged-only main beat).
 * Every rule needs evidence from AFTER the ask (Creed B1):
 *  - the card(s) its subject names are all done, each done after the ask (no done time = no proof);
 *  - its recipient later sent the requester a done/inform/agree/refuse in the same conversation
 *    that answers THIS ask (in_reply_to names it, or names nothing and it is the latest open ask);
 *  - its subject opens with a release whose first start (or a later release's) came after the ask.
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

const { staleObligations, isOpenObligation } = loadTs('src/main/mailLedger.ts');
const { HiveManager, cardDoneAt } = loadTs('src/main/hive.ts');
const { readSource, codeOnly } = require('./read-source.cjs');

const H = 3600_000;
let seq = 0;
function entry(o) {
  seq++;
  return { id: o.id ?? `m${seq}`, from: o.from, act: o.act ?? 'request', subject: o.subject ?? 'x', conversation: o.conversation,
    inReplyTo: o.inReplyTo ?? null, ...(o.senderId ? { senderId: o.senderId } : {}),
    bodyHash: null, via: 'inbox', state: o.state ?? 'acted', seq, deliveredAt: o.at ?? seq, surfaceCount: 1, unconfirmedSurfacings: 0,
    redelivered: false, legacy: false, requiresReply: o.requiresReply ?? (o.act ?? 'request') === 'request',
    repliedAt: o.repliedAt ?? null, closedAt: o.closedAt ?? null, updatedAt: o.at ?? seq };
}
function doc(agentId, ...entries) {
  return { version: 1, agentId, nextSeq: entries.length + 1, lastActivityAt: null, lastActedAt: null, entries: Object.fromEntries(entries.map((e) => [e.id, e])) };
}
const reasons = (list) => Object.fromEntries(list.map((s) => [s.id, s.reason]));
const done = (doneAt) => ({ status: 'done', doneAt });

test('card rule: every named card exists and became done AFTER the ask; no done time is no proof', () => {
  const cards = new Map([['ALPHA-1', done(500)], ['BETA-TWO', { status: 'doing', doneAt: null }], ['GAMMA-3', done(600)],
    ['OLD-DONE', done(50)], ['UNDATED-1', done(null)]]);
  const docs = { andy: doc('andy',
    entry({ id: 'a', from: 'god', subject: 'ALPHA-1: fix the thing', at: 100 }),
    entry({ id: 'b', from: 'god', subject: 'ALPHA-1 then BETA-TWO', at: 100 }),
    entry({ id: 'c', from: 'god', subject: 'GAMMA-3 and ALPHA-1 (audit both)', at: 100 }),
    entry({ id: 'd', from: 'god', subject: 'NOT-A-CARD is done', at: 100 }),
    entry({ id: 'e', from: 'god', subject: 'alpha-1 lower case is not a card id', at: 100 }),
    entry({ id: 'f', from: 'god', subject: 'XALPHA-1 is another id', at: 100 }),
    // Creed B1: a NEW ask about a card that was already done (a follow-up bug) stays open.
    entry({ id: 'followup', from: 'god', subject: 'OLD-DONE: the taskbar pin still opens the old exe', at: 100 }),
    entry({ id: 'undated', from: 'god', subject: 'UNDATED-1: check it', at: 100 }),
    entry({ id: 'mixed', from: 'god', subject: 'ALPHA-1 and OLD-DONE', at: 100 })) };
  assert.deepEqual(reasons(staleObligations(docs, cards, [])), { a: 'auto:card-done:ALPHA-1', c: 'auto:card-done:GAMMA-3,ALPHA-1' });
});

test('cardDoneAt: doneAt, else the newest stamp in the result, else null; never for a card not done', () => {
  assert.equal(cardDoneAt({ status: 'done', doneAt: '2026-10-03T10:00:00.000Z', result: '[2026-10-03T11:00:00.000Z] x' }), Date.parse('2026-10-03T10:00:00.000Z'));
  assert.equal(cardDoneAt({ status: 'done', result: '\n[2026-10-02T09:00:00.000Z] built\n[2026-10-03T10:50:40.697Z] verified' }), Date.parse('2026-10-03T10:50:40.697Z'));
  assert.equal(cardDoneAt({ status: 'done', result: 'shipped, no stamp' }), null);
  assert.equal(cardDoneAt({ status: 'done' }), null);
  assert.equal(cardDoneAt({ status: 'doing', doneAt: '2026-10-03T10:00:00.000Z' }), null);
});

test('conversation rule: a later answer to THIS ask, back to the requester (in_reply_to, or the latest open ask)', () => {
  const ask = (id, conv, at) => entry({ id, from: 'god', subject: 'please do it', conversation: conv, at });
  const back = (act, conv, at, o = {}) => entry({ from: o.from ?? 'andy', act, subject: 'about it', conversation: conv, at, requiresReply: false, inReplyTo: o.inReplyTo });
  const docs = {
    andy: doc('andy', ask('done1', 'c-done', 10), ask('inform1', 'c-inf', 10), ask('agree1', 'c-agr', 10), ask('refuse1', 'c-ref', 10),
      ask('query1', 'c-q', 10), ask('req1', 'c-r', 10), ask('earlier1', 'c-early', 10), ask('other1', 'c-other', 10), ask('noconv', undefined, 10),
      // Creed n1: two asks in one conversation; an answer naming no ask answers only the latest.
      ask('first', 'c-two', 10), ask('second', 'c-two', 12),
      // An answer that names an ask closes that ask only, even when it is not the latest.
      ask('named', 'c-named', 10), ask('later', 'c-named', 12)),
    god: doc('god', back('done', 'c-done', 20), back('inform', 'c-inf', 20), back('agree', 'c-agr', 20), back('refuse', 'c-ref', 20),
      back('query', 'c-q', 20), back('request', 'c-r', 20), back('done', 'c-early', 5), back('done', 'c-other', 20, { from: 'jim' }), back('done', undefined, 20),
      back('inform', 'c-two', 20),
      back('done', 'c-named', 20, { inReplyTo: 'named' })),
  };
  const got = reasons(staleObligations(docs, new Map(), []));
  assert.deepEqual(Object.keys(got).sort(), ['agree1', 'done1', 'inform1', 'named', 'refuse1', 'second']);
  assert.match(got.done1, /^auto:answered:done:m\d+$/);
});

test('release rule: the first start of that release (or a later one) came after the ask', () => {
  const T82 = 1000;
  const runs = [{ version: '1.1.80', firstRunAt: 400 }, { version: '1.1.82', firstRunAt: T82 }, { version: '1.1.83', firstRunAt: 5000 }];
  const docs = { jim: doc('jim',
    entry({ id: 'r82', from: 'god', subject: '1.1.82: audit the cut', at: 900 }),
    entry({ id: 'rc80', from: 'god', subject: 'rc/1.1.80 row 5: merge it', at: 300 }),
    entry({ id: 'v81', from: 'god', subject: 'v1.1.81 publish check', at: 900 }),
    entry({ id: 'r84', from: 'god', subject: '1.1.84: build the next one', at: 900 }),
    entry({ id: 'mid', from: 'god', subject: 'fix the 1.1.80 bug', at: 300 }),
    entry({ id: 'long', from: 'god', subject: '1.1.820: not a prefix of 1.1.82', at: 300 }),
    entry({ id: 'quad', from: 'god', subject: '1.1.80.1 hotfix', at: 300 }),
    // Creed B1: a bug report about the release already running stays open, and the next
    // release starting later does not close it either.
    entry({ id: 'bug82', from: 'god', subject: '1.1.82: Task Manager shows the long tagline', at: 1500 }),
    entry({ id: 'rc80late', from: 'god', subject: 'rc/1.1.80: a follow-up after it ran', at: 450 })) };
  assert.deepEqual(reasons(staleObligations(docs, new Map(), runs)),
    { r82: 'auto:release-shipped:1.1.82', rc80: 'auto:release-shipped:1.1.80', v81: 'auto:release-shipped:1.1.81' });
  assert.deepEqual(staleObligations(docs, new Map(), []), [], 'no release runs, no release evidence');
});

test('never by age alone; replied, closed and non-obligations are left alone', () => {
  const old = Date.now() - 65 * H;
  const docs = { andy: doc('andy',
    entry({ id: 'dropped', from: 'god', subject: 'Review PR 12', at: old }),
    entry({ id: 'replied', from: 'god', subject: '1.1.80: x', repliedAt: 5 }),
    entry({ id: 'closed', from: 'god', subject: '1.1.80: y', closedAt: 5 }),
    entry({ id: 'fyi', from: 'god', act: 'inform', subject: '1.1.80: z', requiresReply: false }),
    entry({ id: 'query', from: 'god', act: 'query', subject: '1.1.80: still owed', requiresReply: true })) };
  assert.deepEqual(reasons(staleObligations(docs, new Map(), [{ version: '1.1.82', firstRunAt: Date.now() }])),
    { query: 'auto:release-shipped:1.1.80' }, 'a requires_reply query is an obligation too');
});

test('replay: the live floor of 2026-10-03 (anonymised) closes only on evidence after the ask', () => {
  const f = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'requests-stale-183.json'), 'utf8'));
  const open = Object.entries(f.docs).flatMap(([a, d]) => Object.values(d.entries).filter(isOpenObligation).map((e) => `${a}/${e.id}`));
  assert.equal(open.length, 22);
  const closed = staleObligations(f.docs, new Map(Object.entries(f.cards)), f.releases);
  const gone = new Set(closed.map((s) => `${s.agentId}/${s.id}`));
  assert.deepEqual(open.filter((k) => !gone.has(k)).sort(), f.expectStay.slice().sort());
  const by = {};
  for (const s of closed) { const k = s.reason.split(':')[1]; by[k] = (by[k] || 0) + 1; }
  assert.deepEqual(by, f.expectClosedBy);
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
  hive.addTask({ id: 'DONE-BEFORE-1', title: 'old', status: 'done', dependsOn: [], doneAt: new Date(Date.now() - H).toISOString() });
  const byCard = hive.send({ to: 'andy-1', act: 'request', subject: 'SHIP-IT-1: build it', body: 'go' }, 'god-1');
  const followUp = hive.send({ to: 'andy-1', act: 'request', subject: 'DONE-BEFORE-1: it broke again', body: 'go' }, 'god-1');
  const byConv = hive.send({ to: 'andy-1', act: 'request', subject: 'Look at the logs', body: 'go', conversation: 'conv-logs' }, 'god-1');
  const live = hive.send({ to: 'andy-1', act: 'request', subject: 'Review PR 12', body: 'go', conversation: 'conv-pr' }, 'god-1');
  hive.send({ to: 'god-1', act: 'query', subject: 'which PR?', body: '?', conversation: 'conv-pr' }, 'andy-1');
  assert.deepEqual(hive.autoCloseStaleObligations(null), [], 'nothing finished yet; a clarifying query answers nothing');

  await new Promise((r) => setTimeout(r, 5));   // the done time below must be later than the ask (ms clock)
  hive.patchTask('SHIP-IT-1', { status: 'done', doneAt: new Date().toISOString() });
  hive.send({ to: 'god-1', act: 'inform', subject: 'logs are clean', body: 'done', conversation: 'conv-logs' }, 'andy-1');
  const before = ['god-1', 'andy-1'].map((id) => inboxCount(hive, id));
  const closed = hive.autoCloseStaleObligations(null);
  assert.deepEqual(closed.map((s) => s.id).sort(), [byCard.id, byConv.id].sort());
  assert.deepEqual(['god-1', 'andy-1'].map((id) => inboxCount(hive, id)), before, 'closing sends nothing to anyone');
  assert.deepEqual(hive.mailObligations().flatMap((a) => a.openRequests.map((o) => o.id)).sort(), [followUp.id, live.id].sort(),
    'the live ask and the follow-up about an already-done card are left');
  const rows = hive.logTail(500).filter((r) => r && r.kind === 'mail-obligation-closed');
  assert.deepEqual(rows.map((r) => [r.id, r.reason.replace(/:[^:]*$/, '')]).sort(),
    [[byCard.id, 'auto:card-done'], [byConv.id, 'auto:answered:inform']].sort());
  assert.deepEqual(hive.autoCloseStaleObligations(null), [], 'idempotent');
});

test('hive: release runs are seeded once from packaged app-start rows, then the running version is added', async (t) => {
  const { hive } = await floor(t);
  hive.appendLog({ kind: 'app-start', version: '1.1.80', packaged: true, ts: 1000 });
  hive.appendLog({ kind: 'app-start', version: '1.1.80', packaged: true, ts: 2000 });
  hive.appendLog({ kind: 'app-start', version: '1.1.81', packaged: false, ts: 1500 });
  const old = hive.send({ to: 'andy-1', act: 'request', subject: '1.1.82: cut it', body: 'go' }, 'god-1');
  const ran80 = hive.send({ to: 'andy-1', act: 'request', subject: '1.1.80: bug in it', body: 'go' }, 'god-1');
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(hive.autoCloseStaleObligations('1.1.82').map((s) => [s.id, s.reason]), [[old.id, 'auto:release-shipped:1.1.82']]);
  const file = JSON.parse(fs.readFileSync(path.join(hive.root(), 'state', 'app-releases.json'), 'utf8'));
  assert.equal(file.firstRunAt['1.1.80'], 1000, 'the earliest packaged start');
  assert.equal(file.firstRunAt['1.1.81'], undefined, 'a dev (unpackaged) start is not a release');
  assert.equal(typeof file.firstRunAt['1.1.82'], 'number');
  const bug = hive.send({ to: 'andy-1', act: 'request', subject: '1.1.82: bug found while it runs', body: 'go' }, 'god-1');
  assert.deepEqual(hive.autoCloseStaleObligations('1.1.82'), [], 'an ask about the running release stays');
  assert.deepEqual(hive.mailObligations().flatMap((a) => a.openRequests.map((o) => o.id)).sort(), [bug.id, ran80.id].sort());
});

test('WIRING: a packaged-only main beat runs the sweep; only hive.ts auto-closes; the Human\'s close is unchanged', () => {
  const idx = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  assert.match(idx, /function runStaleRequestsBeat\(\): void \{\s*if \(!app\.isPackaged\) return;\s*try \{ hive\.autoCloseStaleObligations\(app\.getVersion\(\)\); \}/);
  assert.match(idx, /function armAlwaysOnBeats\(\): void \{[\s\S]{0,900}if \(staleRequestsTimer\) clearInterval\(staleRequestsTimer\);\s*runStaleRequestsBeat\(\);\s*staleRequestsTimer = setInterval\(runStaleRequestsBeat, 60_000\);/);
  const hiveSrc = codeOnly(readSource('src/main/hive.ts'), 'hive.ts');
  assert.equal((hiveSrc.match(/\.autoCloseObligation\(/g) || []).length, 1);
  assert.equal((idx.match(/autoCloseObligation\(/g) || []).length, 0);
  assert.match(hiveSrc, /return this\.mail\.closeObligation\(agentId, id, 'closed-by-human'\);/);
});
