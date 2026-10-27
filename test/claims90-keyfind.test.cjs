'use strict';
/**
 * CLAIMS-90 keyfind (god c4eea4): on-1 agents did not reach keyed facts that `memory get <right key>` answers.
 *  - DRIFT: the step-3 answer child built its NativeMemoryWiring without index.ts's cardLead, so no served search
 *    printed a card or release brief (the bump / tag / merge lines). The child now passes cardLead through the shared
 *    claims deps, and every option index.ts passes must be passed by the child too (APP_ONLY excepted).
 *  - MISS: a `get` that finds nothing names the nearest existing keys (release.<v> and the cards carrying the same
 *    version, or the cards whose id contains the term's), so a guessed `card.cut-1.1.90` leads to release.1.1.90.
 *  - FIELDS: a card lead with both lastsha and donesha says what each means (DV094 answered donesha for lastsha).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const REPO = path.resolve(__dirname, '..');
const G = loadTs('src/main/claims/get.ts');
const { DEFAULT_KEY_REGISTRY } = loadTs('src/main/claims/registry.ts');
const { claimsDepsFor } = require('./claims-90/claims-deps.cjs');

const BUMP = '57ae9b25' + 'a'.repeat(32);
const TAG = 'ffaa2ae3' + 'b'.repeat(32);
const SHA_D = '2e38a74a' + 'c'.repeat(32);
const SHA_L = 'cddf4d04' + 'd'.repeat(32);
const c = (id, agent, key, at, text, extra = {}) => ({ t: 'claim', id, at, wt: at, agent, kind: 'fact', key, text, source: 'derived', ...extra });
const LEDGERS = {
  derived: [
    c('c_000000000001', 'derived', 'release.1.1.90.bump', '2026-10-17T10:00:00.000Z', `Guppy 1.1.90 version bump: the first commit that sets package.json version to 1.1.90 is ${BUMP.slice(0, 8)} (${BUMP})`, { value: BUMP }),
    c('c_000000000002', 'derived', 'release.1.1.102.tag', '2026-10-24T10:00:00.000Z', `Guppy v1.1.102 tag points at ${TAG}`, { value: TAG }),
    c('c_000000000003', 'derived', 'card.int-1.1.90.status', '2026-10-17T10:00:00.000Z', 'Card INT-1.1.90 status: done', { value: 'done' }),
    c('c_000000000004', 'derived', 'card.mail-stuck-9.lastsha', '2026-10-16T06:07:00.000Z', `Card MAIL-STUCK-9 last commit: ${SHA_L}`, { value: SHA_L }),
    c('c_000000000005', 'derived', 'card.mail-stuck-9.donesha', '2026-10-16T06:15:00.000Z', `Card MAIL-STUCK-9 done sha from creed: ${SHA_D}`, { value: SHA_D, valueAgent: 'creed' }),
  ],
};
const TASKS = [{ id: 'INT-1.1.90', status: 'done' }, { id: 'MAIL-STUCK-9', status: 'done' }, { id: 'REQUESTS-BADGE-84', status: 'done' }, { id: 'CUT-1.1.89', status: 'done' }];
const deps = () => ({ ledgers: LEDGERS, registry: JSON.parse(JSON.stringify(DEFAULT_KEY_REGISTRY)), reconcileItems: [], tasks: TASKS, mailRows: () => null });

test('MISS: nearKeys names release.<v> and the cards carrying the version; by name the cards whose id contains the term (or the reverse); nothing near is []', () => {
  const keys = Object.values(LEDGERS).flat().map((r) => r.key);
  const ids = TASKS.map((t) => t.id);
  assert.deepEqual(G.nearKeys('card.cut-1.1.90', keys, ids), ['release.1.1.90', 'card.int-1.1.90']);
  assert.deepEqual(G.nearKeys('v1.1.102', keys, ids), ['release.1.1.102'], 'a version with a release key and no card');
  assert.deepEqual(G.nearKeys('card.requests-badge', keys, ids), ['card.requests-badge-84'], 'the id contains the term');
  assert.deepEqual(G.nearKeys('card.mail-stuck-9-fix.lastsha', keys, ids), ['card.mail-stuck-9'], 'the term contains the id; the field suffix is dropped');
  assert.deepEqual(G.nearKeys('card.nothing-like-it', keys, ids), []);
  assert.deepEqual(G.nearKeys('card.cut-9.9.9', keys, ids), [], 'a version nothing carries names nothing (not every card by name)');
  const many = Array.from({ length: 10 }, (_, i) => `card.int-${i}-1.1.90.status`);
  assert.equal(G.nearKeys('1.1.90', [...keys, ...many], []).length, G.NEAR_MAX);
});

test('MISS: get prints "no claim under" then the nearest keys line; a hit prints none (MUTANT: near dropped from the miss)', () => {
  const miss = G.resolveGet('card.cut-1.1.90', {}, deps());
  assert.equal(miss.keys.length, 0);
  const text = G.formatGet(miss);
  assert.match(text, /^no claim under card\.cut-1\.1\.90\nnearest keys: release\.1\.1\.90, card\.int-1\.1\.90 \(memory get <key>\)\n$/);
  const none = G.formatGet(G.resolveGet('card.nothing-like-it', {}, deps()));
  assert.equal(none, 'no claim under card.nothing-like-it\n', 'no near key: the one line as before');
  const hit = G.formatGet(G.resolveGet('release.1.1.90', {}, deps()));
  assert.match(hit, new RegExp(`bump: ${BUMP}`));
  assert.doesNotMatch(hit, /nearest keys/);
});

test('FIELDS: a card lead with lastsha and donesha ends with the sha-fields note, outside the cap and in no `label:` form (god 79d690); one without either does not', () => {
  const r = G.resolveGet('MAIL-STUCK-9', {}, deps());
  const t = G.formatGet(r);
  assert.ok(t.endsWith(`\n${G.SHA_FIELDS_NOTE}\n`), 'the note is the last line');
  assert.equal(G.formatGet(r, { history: true }).endsWith(`\n${G.SHA_FIELDS_NOTE}\n`), true, 'the --all view too');
  const lines = t.split('\n');
  assert.ok(lines.some((l) => l.startsWith('lastsha: ')) && lines.some((l) => l.startsWith('donesha')), 'the lead is printed as before');
  assert.doesNotMatch(G.SHA_FIELDS_NOTE, /^[a-zA-Z][a-zA-Z ()-]*: /, 'a note, not a field label');
  assert.ok(G.SHA_FIELDS_NOTE.length <= G.GET_LINE_MAX);
  assert.match(G.SHA_FIELDS_NOTE, /lastsha = newest commit its notes name; donesha = newest sha a done mail reports/);
  assert.ok(!G.formatGet(G.resolveGet('INT-1.1.90', {}, deps())).includes(G.SHA_FIELDS_NOTE), 'no sha fields: no note');
});

test('DRIFT: the answer child\'s claims deps answer the search briefs (cardLead) through main\'s claimCardLeadOver: a bump query names release.1.1.90 and leads with its bump', () => {
  const hive = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-'));
  try {
    const store = { readLedger: (a) => ({ records: LEDGERS[a] ?? [], torn: null, chain: 'ok' }) };
    const d = claimsDepsFor(loadTs, { hive, store, agents: () => Object.keys(LEDGERS), allTasks: () => TASKS });
    assert.equal(typeof d.cardLead, 'function');
    const r = d.cardLead({ cards: [], texts: ['bump 1.1.90 version commit'] });
    assert.deepEqual(r.named, ['release.1.1.90']);
    assert.ok(r.briefs['release.1.1.90'].some((l) => l === `bump: ${BUMP}`), JSON.stringify(r.briefs));
  } finally { fs.rmSync(hive, { recursive: true, force: true }); }
});

/** The option names of the first `new NativeMemoryWiring({ ... })` in a source: the keys at the literal's own indent. */
function wiringKeys(src) {
  const at = src.indexOf('new NativeMemoryWiring({');
  assert.ok(at >= 0);
  const lines = src.slice(at).split(/\r?\n/).slice(1);
  const indent = /^(\s*)/.exec(lines[0])[1];
  const keys = new Set();
  for (const l of lines) {
    if (l.trim() && !l.startsWith(indent)) break;
    const m = new RegExp(`^${indent}([A-Za-z_$][\\w$]*)\\s*(?::|,|\\()`).exec(l);
    if (m) keys.add(m[1]);
  }
  return keys;
}
/** Options only the app passes (writes the answerer never makes). */
const APP_ONLY = new Set(['searchLog']);

test('DRIFT: every NativeMemoryWiring option index.ts passes, the answer child passes too (APP_ONLY excepted) (MUTANT: the child drops cardLead)', () => {
  const app = wiringKeys(fs.readFileSync(path.join(REPO, 'src/main/index.ts'), 'utf8'));
  const child = wiringKeys(fs.readFileSync(path.join(REPO, 'test/claims-90/answer-child.cjs'), 'utf8'));
  assert.ok(app.has('cardLead') && app.has('claims') && app.size >= 12, [...app].join(','));
  const missing = [...app].filter((k) => !child.has(k) && !APP_ONLY.has(k));
  assert.deepEqual(missing, [], `the answer child does not pass: ${missing.join(', ')}`);
});
