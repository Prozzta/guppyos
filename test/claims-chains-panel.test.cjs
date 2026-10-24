'use strict';
require('./tools/own-job.cjs');
/**
 * CL-M4-CHAINS-PANEL: "possible duplicates" in Settings > Claim Ledger (the Human's choice, option a of
 * Jim's CL-M4 backlog prefilter). Live claims of one agent that name the same card (Jim's card rule,
 * the build number dropped) or share a key, grouped newest first. The Human keeps one (the others get a
 * `reconcile-answer supersedes` by the Human) or keeps all (`keep-both`); main confirms, a cancel writes
 * nothing, every step is revertible, and nothing is ever superseded without the Human's click.
 * Sandbox hives under a jailed HOME only: nothing here touches the live hive.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-claims-chains-'));
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
const ROOT = path.join(__dirname, '..');
const { ClaimStore } = loadTs(path.join(ROOT, 'src/main/claims/store.ts'));
const { SandboxKeyProvider, FileLedgerKeyRecord, FileHeadAnchorStore, KEY_RECORD_FILE, HEAD_ANCHOR_FILE } = loadTs(path.join(ROOT, 'src/main/claims/keyProvider.ts'));
const { derive } = loadTs(path.join(ROOT, 'src/main/claims/derive.ts'));
const { verifiedPrefix } = loadTs(path.join(ROOT, 'src/main/claims/indexSync.ts'));
const { DEFAULT_KEY_REGISTRY } = loadTs(path.join(ROOT, 'src/main/claims/registry.ts'));
const { createLedgerUi } = loadTs(path.join(ROOT, 'src/main/claims/ledgerUi.ts'));
const { duplicateChains, chainTitle, settledPairs, defaultTicked, CHAIN_TICK_MAX } = loadTs(path.join(ROOT, 'src/shared/claimsUi.ts'));
const { cardIds } = loadTs(path.join(ROOT, 'src/shared/cardIds.ts'));
const FWD = loadTs(path.join(ROOT, 'src/main/claims/candidates.ts'));

let n = 0;
function mkStore() {
  const root = path.join(JAIL, `hive-${++n}`);
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  const ud = `${root}-userdata`;
  let t = Date.parse('2026-10-16T10:00:00Z');
  const store = new ClaimStore({
    hiveRoot: root, keys: new SandboxKeyProvider(), keyRecord: new FileLedgerKeyRecord(path.join(ud, KEY_RECORD_FILE)),
    headAnchor: new FileHeadAnchorStore(path.join(ud, HEAD_ANCHOR_FILE)), now: () => new Date(t += 1000), alert: () => {}, log: () => {},
  });
  STORES.push(store);
  return { root, store };
}
const note = (text, extra = {}) => ({ t: 'claim', kind: 'fact', text, ...extra });
async function ok(p) { const r = await p; assert.equal(r.ok, true, JSON.stringify(r)); return r.id; }

function ui(store, over = {}) {
  const calls = { confirm: [], logs: [], reconciled: [] };
  let answer = true;
  const deps = {
    store: () => store, agents: () => ['andy'], level: () => 'writer', savedLevel: () => 'writer', saveLevel: () => {},
    levelChanged: () => Promise.resolve(), registry: () => DEFAULT_KEY_REGISTRY, derive, verifiedPrefix,
    exportComplete: () => ({ ok: false, error: 'not here' }), scrubExport: () => 0,
    confirm: async (q) => { calls.confirm.push(q); return answer; },
    log: (r) => calls.logs.push(r),
    onReconcile: (a, x, y) => calls.reconciled.push([a, x, y]),
    ...over,
  };
  return { api: createLedgerUi(deps), calls, answer: (a) => { answer = a; } };
}

/** andy: three notes about one card, a pair under one label, and an unrelated note. */
async function seeded(store) {
  const w1 = await ok(store.appendRecord('andy', note('CL-W7 shipped the purge dialog'), 'endpoint'));
  const w2 = await ok(store.appendRecord('andy', note('CL-W7 fix round merged at int a8db887e'), 'endpoint'));
  const k1 = await ok(store.appendRecord('andy', note('use the jailed harness for shots', { key: 'list.shots' }), 'endpoint'));
  const other = await ok(store.appendRecord('andy', note('nothing to do with anything'), 'endpoint'));
  const k2 = await ok(store.appendRecord('andy', note('shots at DPR 1, 1280x800', { key: 'list.shots' }), 'endpoint'));
  const w3 = await ok(store.appendRecord('andy', note('CL-W7 is done; next is CL-M4-FORWARD-PATH'), 'endpoint'));
  return { w1, w2, w3, k1, k2, other };
}
const records = (store) => store.readLedger('andy').records;
const stateOf = (store) => derive(verifiedPrefix(store.readLedger('andy')).records, DEFAULT_KEY_REGISTRY, { r4: false }).claims;

// ------------------------------------------------------------------ the pure grouping

test('card ids: one shared rule; the panel groups on the full token, FORWARD drops the build number', () => {
  assert.deepEqual(cardIds('CL-W7-189 and TES-BUBBLE-NITS-189, not ABC or ok-ish or 1.1.89'), ['CL-W7-189', 'TES-BUBBLE-NITS-189']);
  assert.deepEqual(cardIds('the fix for CL-M4-FORWARD-PATH and CL-M4-FORWARD-PATH again'), ['CL-M4-FORWARD-PATH']);
  assert.deepEqual(cardIds('no card here', 'card.cl-w7'), ['CL-W7']);
  // NAME-NNN cards count (Jim, SHOULD 2); a one-word name with a short number, or a standard's name, does not.
  assert.deepEqual(cardIds('WAKE-155 and START-175 and POST-INSTALL-188; GATE-4, RC-1, SHA-256, UTF-16, ISO-8601, X-189'), ['WAKE-155', 'START-175', 'POST-INSTALL-188']);
  assert.deepEqual(cardIds('PROMOTE-RUNBOOK-1 and ZT-I3'), ['PROMOTE-RUNBOOK-1', 'ZT-I3']);
  // FORWARD drops the build number through the same helper, so release families still merge; a NAME-NNN card,
  // which dropping would leave without a hyphen, stays whole (CL-M4-FWD-NAMENNN). Standards and short numbers stay out.
  const fwd = 'CL-W7-189 and TES-BUBBLE-NITS-189 and WAKE-155 (UTF-16)';
  assert.deepEqual(cardIds(fwd, undefined, { dropBuild: true }), ['CL-W7', 'TES-BUBBLE-NITS', 'WAKE-155']);
  assert.deepEqual(FWD.cardIds(fwd), cardIds(fwd, undefined, { dropBuild: true }));
  assert.deepEqual(FWD.cardIds('WAKE-155 and START-175; SHA-256, GATE-4, RC-1, X-189, ISO-8601'), ['WAKE-155', 'START-175']);
  assert.deepEqual(FWD.cardIds('TES-BUBBLE-NITS-189'), FWD.cardIds('TES-BUBBLE-NITS-188'));
  assert.deepEqual(FWD.cardIds('POST-INSTALL-188 and POST-INSTALL-189'), ['POST-INSTALL']);
  assert.deepEqual(FWD.cardIds('x', 'card.wake-155'), ['WAKE-155']);
  assert.deepEqual(FWD.cardIds('x', 'card.heavy-lock-shapes-189'), ['HEAVY-LOCK-SHAPES']);
});

test('duplicateChains: one group per release card (POST-INSTALL-188 is not POST-INSTALL-189); NAME-NNN cards group', () => {
  const claims = [
    C('c-01', 'POST-INSTALL-188 ok', '2026-10-01'), C('c-02', 'POST-INSTALL-188 again', '2026-10-02'),
    C('c-03', 'POST-INSTALL-189 ok', '2026-10-03'), C('c-04', 'WAKE-155 open', '2026-10-04'), C('c-05', 'WAKE-155 done', '2026-10-05'),
    C('c-06', 'GATE-4 passed', '2026-10-06'), C('c-07', 'GATE-4 failed on another plan', '2026-10-07'),
  ];
  assert.deepEqual(duplicateChains({ claims, events: [] }).map((c) => [c.id, c.members]), [['card:WAKE-155', ['c-05', 'c-04']], ['card:POST-INSTALL-188', ['c-02', 'c-01']]]);
});

test('duplicateChains: a soft-superseded note (superseded?) is not grouped; only live notes are', () => {
  const claims = [C('c-01', 'CL-W7 a', '2026-10-01', { status: 'superseded?' }), C('c-02', 'CL-W7 b', '2026-10-02'), C('c-03', 'CL-W7 c', '2026-10-03')];
  assert.deepEqual(duplicateChains({ claims, events: [] })[0].members, ['c-03', 'c-02']);
  assert.equal(duplicateChains({ claims: claims.slice(0, 2), events: [] }).length, 0);
});

test('ticks: a group of up to 3 notes starts all ticked; a larger one starts with none', () => {
  assert.equal(CHAIN_TICK_MAX, 3);
  assert.deepEqual(defaultTicked(['a', 'b', 'c']), ['a', 'b', 'c']);
  assert.deepEqual(defaultTicked(['a', 'b', 'c', 'd']), []);
});

const C = (id, text, wt, o = {}) => ({ id, kind: 'fact', text, source: 'self', at: wt, wt, status: 'live', sightings: 0, pinned: false, reasons: [], ...o });
const E = (id, ev, targets, o = {}) => ({ id, ev, targets, by: 'human', at: '2026-10-16', reverted: false, revertible: true, ...o });

test('duplicateChains: live claims only, newest first, groups of two or more, the newest group first, shared sets merged', () => {
  const claims = [
    C('c-01', 'CL-W7 a', '2026-10-01'), C('c-02', 'CL-W7 b', '2026-10-02'), C('c-03', 'x', '2026-10-03', { key: 'list.a' }),
    C('c-04', 'y', '2026-10-05', { key: 'list.a' }), C('c-05', 'CL-W7 old', '2026-09-01', { status: 'superseded' }),
    C('c-06', 'alone ONE-CARD', '2026-10-06'), C('c-07', 'P-Q and R-S', '2026-10-04'), C('c-08', 'P-Q and R-S again', '2026-10-03'),
  ];
  const ch = duplicateChains({ claims, events: [] });
  assert.deepEqual(ch.map((c) => c.id), ['key:list.a', 'card:P-Q+card:R-S', 'card:CL-W7']);
  assert.deepEqual(ch[0].members, ['c-04', 'c-03']);
  assert.deepEqual(ch[2].members, ['c-02', 'c-01'], 'the superseded one is not offered; newest first');
  assert.deepEqual(ch[1].reasons, [{ kind: 'card', value: 'P-Q' }, { kind: 'card', value: 'R-S' }]);
  assert.equal(chainTitle(ch[0]), 'Notes filed under the label "list.a"');
  assert.equal(chainTitle(ch[1]), 'Notes about card P-Q, and about card R-S');
  // An equal write time falls back to the id, so the order is stable.
  assert.deepEqual(duplicateChains({ claims: [C('c-0b', 'K-1X', 't'), C('c-0a', 'K-1X', 't')], events: [] })[0].members, ['c-0a', 'c-0b']);
});

test('duplicateChains: a group already kept whole leaves the list; a newer note or a revert brings it back', () => {
  const claims = [C('c-01', 'CL-W7 a', '2026-10-01'), C('c-02', 'CL-W7 b', '2026-10-02'), C('c-03', 'CL-W7 c', '2026-10-03')];
  const both = [E('e-1', 'reconcile-answer', ['c-01', 'c-03'], { answer: 'keep-both' }), E('e-2', 'dismiss', ['c-02', 'c-03'])];
  assert.equal(duplicateChains({ claims, events: both }).length, 0, 'every older one stands beside the newest');
  assert.equal(duplicateChains({ claims, events: both.slice(0, 1) }).length, 1, 'one pair still open');
  assert.equal(duplicateChains({ claims, events: [both[0], { ...both[1], reverted: true }] }).length, 1, 'a reverted answer does not count');
  assert.equal(duplicateChains({ claims, events: [both[0], E('e-3', 'reconcile-answer', ['c-02', 'c-03'], { answer: 'supersedes' })] }).length, 1, 'only keep-both or a dismiss settle a pair');
  const later = [...claims, C('c-04', 'CL-W7 d', '2026-10-04')];
  assert.deepEqual(duplicateChains({ claims: later, events: both })[0].members, ['c-04', 'c-03', 'c-02', 'c-01'], 'a newer note reopens it');
  assert.equal(settledPairs([E('e-4', 'dismiss', ['c-01'])]).size, 0, 'a one-target dismiss settles no pair');
});

// ------------------------------------------------------------------ the main side (a real store)

test('keep one: the confirm comes first; a cancel writes nothing; OK sets the others aside by the Human, revertibly', async () => {
  const { store } = mkStore();
  const s = await seeded(store);
  const u = ui(store);
  const v = u.api.view('andy');
  const chains = duplicateChains(v);
  assert.deepEqual(chains.map((c) => c.id), ['card:CL-W7', 'key:list.shots']);
  assert.deepEqual(chains[0].members, [s.w3, s.w2, s.w1]);
  const n0 = records(store).length;
  u.answer(false);
  const no = await u.api.keepOne('andy', s.w3, [s.w2, s.w1]);
  assert.equal(no.ok, false); assert.equal(no.cancelled, true);
  assert.equal(records(store).length, n0, 'a cancel writes nothing');
  assert.equal(u.calls.confirm.length, 1);
  const q = u.calls.confirm[0];
  assert.equal(q.title, 'Keep one note?');
  assert.ok(q.message.includes('CL-W7 is done') && q.message.includes('the other 2 notes'), q.message);
  assert.ok(q.detail.includes('Nothing is deleted') && q.detail.includes('Revert'), q.detail);
  assert.ok(!/supersed|reconcile|claim/i.test(`${q.title} ${q.message} ${q.detail}`), 'plain wording, no ledger jargon');
  u.answer(true);
  const r = await u.api.keepOne('andy', s.w3, [s.w2, s.w1]);
  assert.equal(r.ok, true, JSON.stringify(r));
  const evs = records(store).slice(n0);
  assert.equal(evs.length, 2);
  for (const [i, loser] of [s.w2, s.w1].entries()) {
    assert.equal(evs[i].ev, 'reconcile-answer'); assert.equal(evs[i].answer, 'supersedes'); assert.equal(evs[i].by, 'human');
    assert.deepEqual(evs[i].targets, [loser, s.w3]);
  }
  const st = stateOf(store);
  assert.equal(st[s.w3].status, 'live');
  assert.equal(st[s.w2].status, 'superseded'); assert.equal(st[s.w2].supersededBy, s.w3);
  assert.equal(st[s.w1].status, 'superseded');
  assert.deepEqual(u.calls.reconciled, [['andy', s.w3, s.w2], ['andy', s.w3, s.w1]], 'the hive reconcile queue drops the answered pairs');
  assert.deepEqual(u.calls.logs.map((l) => [l.kind, l.target, l.ok]), [['claims-ui-keep-one', s.w2, true], ['claims-ui-keep-one', s.w1, true]]);
  assert.deepEqual(duplicateChains(u.api.view('andy')).map((c) => c.id), ['key:list.shots'], 'the group is resolved');
  // Revert one step: that note is live again and the group (of two) is back.
  const ev = u.api.view('andy').events.find((e) => e.id === evs[0].id);
  assert.equal(ev.revertible, true);
  assert.equal((await u.api.revert('andy', evs[0].id)).ok, true);
  assert.equal(stateOf(store)[s.w2].status, 'live');
  assert.deepEqual(duplicateChains(u.api.view('andy')).find((c) => c.id === 'card:CL-W7').members, [s.w3, s.w2]);
});

test('keep one: only the ticked notes are set aside; an unticked one stays as it is', async () => {
  const { store } = mkStore();
  const s = await seeded(store);
  const u = ui(store);
  assert.equal((await u.api.keepOne('andy', s.w2, [s.w1])).ok, true, 'an older one may be the one kept');
  const st = stateOf(store);
  assert.equal(st[s.w1].status, 'superseded'); assert.equal(st[s.w1].supersededBy, s.w2);
  assert.equal(st[s.w2].status, 'live'); assert.equal(st[s.w3].status, 'live');
  assert.ok(/the other note\?/.test(u.calls.confirm[0].message), u.calls.confirm[0].message);
});

test('keep all: keep-both pairs with the newest, by the Human; nothing is set aside; the group leaves the list', async () => {
  const { store } = mkStore();
  const s = await seeded(store);
  const u = ui(store);
  const n0 = records(store).length;
  u.answer(false);
  assert.equal((await u.api.keepAll('andy', [s.k2, s.k1])).cancelled, true);
  assert.equal(records(store).length, n0, 'a cancel writes nothing');
  u.answer(true);
  const r = await u.api.keepAll('andy', [s.k2, s.k1]);
  assert.equal(r.ok, true, JSON.stringify(r));
  const evs = records(store).slice(n0);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].ev, 'reconcile-answer'); assert.equal(evs[0].answer, 'keep-both'); assert.equal(evs[0].by, 'human');
  assert.deepEqual(evs[0].targets, [s.k1, s.k2]);
  const st = stateOf(store);
  for (const id of Object.values(s)) assert.equal(st[id].status, 'live', `${id} stays live`);
  assert.deepEqual(duplicateChains(u.api.view('andy')).map((c) => c.id), ['card:CL-W7']);
  assert.equal(u.calls.confirm[0].title, 'Keep all of them?');
  assert.ok(!/supersed|reconcile|claim/i.test(`${u.calls.confirm[0].message} ${u.calls.confirm[0].detail}`));
  // A partly answered group writes only the open pairs.
  const n1 = records(store).length;
  await ok(store.appendRecord('andy', { t: 'event', ev: 'reconcile-answer', targets: [s.w1, s.w3], answer: 'keep-both' }, 'ui-ipc'));
  assert.equal((await u.api.keepAll('andy', [s.w3, s.w2, s.w1])).ok, true);
  const more = records(store).slice(n1 + 1);
  assert.deepEqual(more.map((e) => e.targets), [[s.w2, s.w3]]);
  assert.equal(duplicateChains(u.api.view('andy')).length, 0);
});

test('refusals write nothing and ask nothing: stale, mixed groups, bad or repeated ids, part of a group, read-only', async () => {
  const { store } = mkStore();
  const s = await seeded(store);
  const u = ui(store);
  const n0 = records(store).length;
  const refused = async (p, re) => { const r = await p; assert.equal(r.ok, false); assert.ok(re.test(r.error), r.error); };
  await refused(u.api.keepOne('andy', s.w3, []), /pick at least one/);
  await refused(u.api.keepOne('andy', s.w3, 'c-0'), /pick at least one/);
  await refused(u.api.keepOne('andy', s.w3, [s.w3]), /named twice/);
  await refused(u.api.keepOne('andy', s.w3, ['e-0123456789abcdef']), /bad claim ids/);
  await refused(u.api.keepOne('andy', 7, [s.w1]), /bad claim ids/);
  await refused(u.api.keepOne('andy', s.w3, [s.k1]), /not one group/);
  await refused(u.api.keepOne('andy', s.w3, [s.other]), /not one group/);
  await refused(u.api.keepOne('../x', s.w3, [s.w1]), /bad agent id/);
  await refused(u.api.keepAll('andy', [s.w3, s.w2]), /group changed/);
  await refused(u.api.keepAll('andy', [s.w3]), /at least two/);
  await refused(u.api.keepAll('andy', [s.w3, s.k1]), /not one group/);
  // Stale: a note set aside since the list was drawn.
  await ok(store.appendRecord('andy', { t: 'event', ev: 'reconcile-answer', targets: [s.w1, s.w3], answer: 'supersedes' }, 'ui-ipc'));
  await refused(u.api.keepOne('andy', s.w3, [s.w2, s.w1]), /no longer a live note/);
  assert.equal(records(store).length, n0 + 1, 'only the test\'s own append');
  assert.equal(u.calls.confirm.length, 0, 'no dialog for a refused request');
  // A read-only ledger (a chain break) refuses before any dialog.
  const roStore = { readLedger: (a) => ({ ...store.readLedger(a), chain: { reason: 'hash mismatch', brokenAt: s.k2 } }), appendRecord: store.appendRecord.bind(store), purge: store.purge.bind(store) };
  const r2 = ui(roStore);
  await refused(r2.api.keepOne('andy', s.w3, [s.w2]), /read-only/);
  assert.equal(r2.calls.confirm.length, 0);
});

test('nothing is chosen automatically: listing reads only, and only the Settings IPC reaches the choices', async () => {
  const { store } = mkStore();
  await seeded(store);
  const u = ui(store);
  const n0 = records(store).length;
  for (let i = 0; i < 3; i++) { duplicateChains(u.api.view('andy')); u.api.summary(); }
  assert.equal(records(store).length, n0, 'viewing the groups writes nothing');
  assert.equal(u.calls.confirm.length, 0);
  const main = fs.readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8');
  for (const ch of ['keep-one', 'keep-all']) {
    const line = main.split('\n').find((l) => l.includes(`'claims-ui:${ch}'`));
    assert.ok(line && line.includes('ledgerUiSender(evt) ?'), `claims-ui:${ch} is guarded to the app window`);
  }
  for (const f of ['src/main/claims/endpoint.ts', 'src/main/hookServer.ts', 'src/main/claims/worker.ts']) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) assert.ok(!/keepOne|keepAll|keep-one|keep-all/.test(fs.readFileSync(p, 'utf8')), `${f} cannot reach the choices`);
  }
  const pre = fs.readFileSync(path.join(ROOT, 'src/preload/index.ts'), 'utf8');
  assert.ok(pre.includes("ipcRenderer.invoke('claims-ui:keep-one', agentId, keep, retire)") && pre.includes("ipcRenderer.invoke('claims-ui:keep-all', agentId, ids)"));
});

test('the panel: plain words and no automatic choice (the renderer source)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/src/components/ClaimLedgerSettings.tsx'), 'utf8');
  const at = src.indexOf('function DupChainCard');
  const card = src.slice(at, src.indexOf('\nfunction ', at + 1));
  assert.ok(src.includes('possible duplicates {chains.length}'));
  assert.ok(src.includes('Nothing changes until you choose'));
  assert.ok(/onClick=\{\(\) => onKeepOne\(id, others\)\}/.test(card), 'keep one only on a click');
  assert.ok(/onClick=\{onKeepAll\}/.test(card), 'keep all only on a click');
  assert.ok(!/useEffect/.test(card), 'the group card does nothing by itself');
  assert.ok(/useState<Set<string>>\(\(\) => \{ const on = new Set\(defaultTicked\(chain\.members\)\)/.test(card), 'the first ticks come from defaultTicked');
  assert.ok(/variant=\{busy \? 'ghost' : 'secondary'\} disabled=\{busy\}[^>]*>keep all</.test(card), 'a disabled keep all is not drawn highlighted');
  const visible = (card.match(/>[^<>{}]+</g) ?? []).join(' ') + (card.match(/title=\{?[`'"][^`'"]*/g) ?? []).join(' ');
  assert.ok(!/supersed|reconcile|claim/i.test(visible), `plain words: ${visible}`);
});
