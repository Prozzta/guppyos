'use strict';

/**
 * WSG-CODEX-STARTUP-NO-MARKER + WSG-ALERT-NOT-DISMISSABLE (1.1.78), the parts outside the submit
 * owner (_work/WSG-NO-MARKER-177.md, fixes 2-5). Fix 1 (the latch deadlock) and the owner side of
 * fix 3 are in wake-screen-guard.test.cjs, next to the rig they need.
 *
 *   fix 2  a refused AUTOMATIC queue item (an auto /compact) no longer holds a message a PERSON
 *          typed behind it (queueDelivery.pickQueuedForDelivery);
 *   fix 3  the composer says plainly what the screen check holds, and offers "send now" only
 *          when main says a person's send passes (shared/deliveryHold.ts SCREEN);
 *   fix 4  the screen-guard notice is LIFTED by the first ok reading, a latch or a respawn, and a
 *          person can dismiss it (codexScreenGuard.ScreenGuardNotices, shared/integrityBanner.ts);
 *   fix 5  the notice is worded for a person (mailLedger.screenGuardNoticeText, Jim's draft).
 *
 * Mutants that must die (MUTANT CENSUS below): each named guarantee has one.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');

const ROOT = path.resolve(__dirname, '..');
const QUEUE = loadTs('src/renderer/src/hooks/queueDelivery.ts');
const GUARD = loadTs('src/main/codexScreenGuard.ts');
const BANNER = loadTs('src/shared/integrityBanner.ts');
const HOLD = loadTs('src/shared/deliveryHold.ts');
const LEDGER = loadTs('src/main/mailLedger.ts');

const K = {};

// ─── fix 2: head-of-line ────────────────────────────────────────────────────────────────

const compact = { id: 'q-3', text: '/compact' };
const hello = { id: 'q-4', text: 'hello?', human: true };
const hi = { id: 'q-5', text: 'hi', human: true };

K.humanNotHeldBehindRefusedAutomatic = (Q = QUEUE) => {
  // WSG-NO-MARKER-177: the store held [/compact, hello?]; the drain only ever offered /compact.
  assert.equal(Q.pickQueuedForDelivery([compact, hello, hi], new Set(['q-3'])), hello,
    'A PERSON\'S MESSAGE IS NOT HELD BEHIND A REFUSED AUTOMATIC ITEM');
  assert.equal(Q.pickQueuedForDelivery([compact, { id: 'q-9', text: 'nudge' }, hi], new Set(['q-3'])), hi, 'the first person\'s message, past every automatic one');
};
K.orderUnchangedWhileNothingRefused = (Q = QUEUE) => {
  assert.equal(Q.pickQueuedForDelivery([compact, hello], new Set()), compact, 'ORDER IS UNCHANGED WHILE NOTHING IS REFUSED');
  assert.equal(Q.pickQueuedForDelivery([hello, compact], new Set(['q-3'])), hello, 'a person\'s head stays the head');
  assert.equal(Q.pickQueuedForDelivery([{ ...compact, manual: true }, hello], new Set(['q-3'])).id, 'q-3', 'a "send now" head stays the head');
  assert.equal(Q.pickQueuedForDelivery([compact, { id: 'q-9', text: 'nudge' }], new Set(['q-3'])), compact, 'no person waiting: the head');
  assert.equal(Q.pickQueuedForDelivery([], new Set()), undefined);
  assert.equal(Q.pickQueuedForDelivery(undefined, new Set()), undefined);
};
test('fix 2: a refused automatic /compact no longer holds the person\'s message behind it', () => K.humanNotHeldBehindRefusedAutomatic());
test('fix 2: the queue order is unchanged otherwise (nothing refused, a person\'s or a "send now" head)', () => K.orderUnchangedWhileNothingRefused());

test('fix 2 wiring: the composer marks a person\'s message, the store keeps it, the drain picks and records refusals', () => {
  const composer = readSource('src/renderer/src/components/MessageQueueComposer.tsx');
  assert.match(composer, /enqueueMessage\(agent\.id, body, \{ human: true \}\);/);
  const store = readSource('src/renderer/src/store/store.ts');
  assert.match(store, /\.\.\.\(meta\?\.human \? \{ human: true as const \} : \{\}\)/);
  const hive = readSource('src/renderer/src/hooks/useHive.ts');
  assert.match(hive, /const next = pickQueuedForDelivery\(messageQueues\[srcId\], refusedAutomatic\);/);
  assert.match(hive, /if \(outcome\.kind === 'REFUSED' \|\| outcome\.kind === 'ABORTED'\) \{\s*if \(!next\.human && !next\.manual\) refusedAutomatic\.add\(next\.id\);/);
  assert.match(hive, /delete sendFailures\[next\.id\];\s*refusedAutomatic\.delete\(next\.id\);/);
});

// ─── fix 4: the notice lifecycle ────────────────────────────────────────────────────────

const MIN = 60_000;
function notices(G = GUARD) {
  const sink = { raised: [], cleared: [] };
  const n = new G.ScreenGuardNotices({ raise: (a) => sink.raised.push(a), clear: (id) => sink.cleared.push(id) }, 5 * MIN);
  return { n, sink };
}
/** Automatic refusals every 6 s from `t0` for `ms`. */
function refuse(n, t0, ms, reason = 'startup:no-marker') {
  let t = t0;
  for (; t <= t0 + ms; t += 6_000) n.reading('dwight', false, reason, true, t);
  return t;
}

K.noticeLiftsOnOk = (G = GUARD) => {
  const { n, sink } = notices(G);
  refuse(n, 0, 6 * MIN);
  assert.equal(sink.raised.length, 1, 'raised once per run');
  assert.equal(sink.raised[0].reason, 'startup:no-marker');
  n.reading('dwight', true, 'ok', false, 7 * MIN);           // a person's send got through
  assert.ok(sink.cleared.includes('dwight'), 'THE NOTICE LIFTS ON THE FIRST OK READING');
  assert.equal(n.hold('dwight', 7 * MIN), null, 'and the composer hold with it');
};
K.noticeLiftsOnLatch = (G = GUARD) => {
  const { n, sink } = notices(G);
  refuse(n, 0, 6 * MIN);
  n.latched('dwight');                                       // its own turn ended (fix 1(b))
  assert.ok(sink.cleared.includes('dwight'), 'THE NOTICE LIFTS ON A LATCH');
  assert.equal(n.hold('dwight', 6 * MIN + 1), null);
};
K.holdThatComesBackAlertsAgain = (G = GUARD) => {
  const { n, sink } = notices(G);
  refuse(n, 0, 6 * MIN);
  n.latched('dwight');
  refuse(n, 10 * MIN, 4 * MIN);
  assert.equal(sink.raised.length, 1, 'a new run starts its own 5 minutes');
  refuse(n, 14 * MIN + 6_000, 2 * MIN);
  assert.equal(sink.raised.length, 2, 'A HOLD THAT COMES BACK ALERTS AGAIN');
};
test('fix 4: the screen-guard notice lifts on the first ok reading', () => K.noticeLiftsOnOk());
test('fix 4: the screen-guard notice lifts on a condition-1 latch', () => K.noticeLiftsOnLatch());
test('fix 4: lifting ends the run, so a hold that comes back is a new run and alerts again', () => K.holdThatComesBackAlertsAgain());

test('fix 4: a respawn lifts; a person\'s refused send never alerts; the composer hold is fresh-only', () => {
  const { n, sink } = notices();
  for (let t = 0; t <= 10 * MIN; t += 6_000) n.reading('dwight', false, 'startup:no-marker', false, t);
  assert.equal(sink.raised.length, 0, 'only automatic starts are waited on');
  assert.equal(n.hold('dwight', 10 * MIN), null, 'a person\'s refused send is no automatic hold');
  n.reading('dwight', false, 'startup:no-marker', true, 11 * MIN);
  assert.deepEqual(n.hold('dwight', 11 * MIN), { reason: 'startup:no-marker' });
  n.reading('dwight', false, 'UNKNOWN:not-the-empty-composer', true, 11 * MIN + 6_000);
  assert.deepEqual(n.hold('dwight', 11 * MIN + 6_000), { reason: 'UNKNOWN:not-the-empty-composer' });
  assert.equal(n.hold('dwight', 11 * MIN + 6_000 + GUARD.SCREEN_HOLD_FRESH_MS + 1), null, 'a stale refusal is no hold');
  n.respawned('dwight');
  assert.ok(sink.cleared.includes('dwight'));
  assert.equal(n.hold('dwight', 11 * MIN + 7_000), null);
});

test('fix 4 wiring: main raises and lifts through the coordinator; the snapshot carries the hold', () => {
  const idx = readSource('src/main/index.ts');
  assert.match(idx, /screenGuardNotices\.reading\(r\.agentId, r\.ok, r\.reason, r\.admissionClass === 'CAPACITY_GATED', Date\.now\(\)\);/);
  assert.match(idx, /hive\.mail\.noteScreenGuardAlert\(a\.agentId, a\.reason, a\.refusedMs, a\.refusals, agentDisplayName\(a\.agentId\), Date\.now\(\)\);/);
  assert.match(idx, /if \(latched && agentId\) screenGuardNotices\.latched\(agentId\);/);
  assert.match(idx, /screenHold: screenGuardNotices\.hold\(agentId, Date\.now\(\)\) \};/);
  assert.doesNotMatch(idx, /ScreenGuardAlertWatch/, 'one owner of the alert');
});

// ─── fix 4: Dismiss ─────────────────────────────────────────────────────────────────────

const alertAt = (raisedAt) => ({ file: 'state/mail/dwight.json', quarantine: null, error: 'wake-screen-guard', notice: 'x', title: 't', raisedAt });
const corrupt = { file: 'tasks.json', quarantine: 'tasks.json.bad', error: 'parse' };

K.dismissCoversOneRaising = (B = BANNER) => {
  const first = alertAt(1000);
  const dismissed = new Set([B.issueKey(first)]);
  assert.deepEqual(B.visibleIssues([first], dismissed), [], 'a dismissed notice is hidden');
  assert.deepEqual(B.visibleIssues([alertAt(9000)], dismissed).length, 1, 'A NEW RAISING SHOWS AGAIN after a dismissal');
};
K.pausedIssueNeverDismissed = (B = BANNER) => {
  assert.equal(B.isDismissible(corrupt), false, 'A DAMAGED FILE THAT PAUSES CHANGES CANNOT BE DISMISSED');
  assert.deepEqual(B.visibleIssues([corrupt], new Set([B.issueKey(corrupt)])), [corrupt], 'it stays in view even if asked');
  assert.equal(B.isDismissible(alertAt(1)), true);
  assert.equal(B.isDismissible({ ...corrupt, repaired: true }), true, 'a rebuilt ledger is a note: dismissible');
};
test('fix 4: Dismiss hides a notice for THIS raising only', () => K.dismissCoversOneRaising());
test('fix 4: a damaged file that pauses changes is never dismissible', () => K.pausedIssueNeverDismissed());

test('fix 4 wiring: the banner filters through visibleIssues and offers Dismiss only for dismissible issues', () => {
  const b = readSource('src/renderer/src/components/IntegrityRepairBanner.tsx');
  assert.match(b, /import \{ isDismissible, issueKey, visibleIssues \} from '@shared\/integrityBanner';/);
  assert.match(b, /const issues = visibleIssues\(allIssues, dismissed\);/);
  assert.match(b, /\{isDismissible\(issue\) && \(\s*<button[\s\S]{0,120}data-integrity-dismiss=""\s*onClick=\{\(\) => dismiss\(issue\)\}/);
  assert.match(b, /\{issue\.title && <span[^>]*>\{issue\.title\}<\/span>\}/);
  assert.match(b, /whiteSpace: 'pre-line'/, 'the notice keeps its lines');
});

// ─── fix 5: the words ──────────────────────────────────────────────────────────────────

test('fix 5: the notice is Jim\'s plain-English draft; the technical reason is only in details', () => {
  const w = LEDGER.screenGuardNoticeText('Dwight', 'startup:no-marker', 300_250, 51);
  assert.equal(w.title, 'Dwight isn\'t getting messages right now.');
  assert.match(w.notice, /^For safety, the app types into Dwight's terminal only when it is sure Dwight is on its normal chat box, and for the last 5 minutes it couldn't confirm that\.\n/);
  assert.match(w.notice, /What to do: click Dwight's terminal and look at the bottom\./);
  assert.match(w.notice, /If you see the chat box \("Ask Codex to do anything"\), press Enter once/);
  assert.match(w.notice, /If you see a question or a menu instead \(trust, login, update\), answer it, or press Esc\./);
  assert.match(w.notice, /This notice goes away by itself when messages flow again\.$/);
  assert.doesNotMatch(`${w.title}\n${w.notice}`, /startup:|no-marker|composer|wake-screen-guard/, 'no jargon in what a person reads first');
  assert.match(w.details, /startup:no-marker, 51 refusals/);
  const one = LEDGER.screenGuardNoticeText('Pam', 'no-reading', 50_000, 1);
  assert.match(one.notice, /for the last 1 minute it/);
  const { MailLedger } = LEDGER;
  const ledger = Object.create(MailLedger.prototype);
  ledger.notices = new Map();
  ledger.log = () => {};
  MailLedger.prototype.noteScreenGuardAlert.call(ledger, 'dwight-mu32ztys', 'startup:no-marker', 300_250, 51, 'Dwight', 42);
  const issue = ledger.notices.get('dwight-mu32ztys|screen-guard');
  assert.equal(issue.title, 'Dwight isn\'t getting messages right now.');
  assert.equal(issue.raisedAt, 42, 'stamped, so a dismissal covers this raising only');
  assert.equal(issue.error, 'wake-screen-guard');
});

// ─── fix 3: what the composer says ──────────────────────────────────────────────────────

const base = { agentName: 'Dwight', interfered: null, paused: false, headManual: false, capacityHold: false, capacityEvidence: null };

K.screenHoldWorded = (H = HOLD) => {
  for (const reason of ['startup:no-marker', 'UNKNOWN:not-the-empty-composer']) {
    const held = H.deliveryHoldView({ ...base, screenHold: { reason } });
    assert.ok(held && held.kind === 'SCREEN', 'A SCREEN HOLD IS SAID');
    assert.equal(held.action, null, '"send now" IS NOT OFFERED for a screen hold (W1: the same check holds it)');
    assert.match(held.hint, /"send now" is held too/, 'and the hint says so plainly');
    assert.match(held.title, /"send now" is held by the same safety check/);
    assert.match(held.title, /Click Dwight's terminal and look at the bottom/, 'and names what a person can do');
  }
};
test('fix 3: the composer says plainly what the screen check holds, and that "send now" is held too', () => K.screenHoldWorded());

test('fix 3: INTERFERED, the pause and capacity keep their precedence; a released head the check holds is still said', () => {
  const sh = { reason: 'startup:no-marker' };
  assert.equal(HOLD.deliveryHoldView({ ...base, screenHold: sh, interfered: { requestId: 'queue:d:q', reason: 'x', at: 1 } }).kind, 'INTERFERED');
  assert.equal(HOLD.deliveryHoldView({ ...base, screenHold: sh, paused: true }).kind, 'PAUSED');
  assert.equal(HOLD.deliveryHoldView({ ...base, screenHold: sh, headManual: true }).kind, 'SCREEN', 'a "send now" head is held by the same check: still said');
  assert.equal(HOLD.deliveryHoldView({ ...base, screenHold: null }), null);
  const composer = readSource('src/renderer/src/components/MessageQueueComposer.tsx');
  assert.match(composer, /const releasable = !delivery\.interfered && \(delivery\.paused \|\| delivery\.capacityHold\);/, 'no "send now" for a screen hold');
  assert.match(composer, /screenHold: delivery\.screenHold\s*\}\);/);
});

// ─── MUTANT CENSUS ──────────────────────────────────────────────────────────────────────

const MUTANT_DIR = path.join(__dirname, '.mutants-wsg178');
function mutate(rel, edits, tag) {
  let text = readSource(rel);
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  // A copy in MUTANT_DIR resolves its sibling imports back to the real files.
  text = text.replace(/from '\.\/(\w+)'/g, (_, m) => `from '${path.relative(MUTANT_DIR, path.join(ROOT, path.dirname(rel), m)).replace(/\\/g, '/')}'`);
  const file = path.join(MUTANT_DIR, `${tag}.ts`);
  fs.writeFileSync(file, text, 'utf8');
  return loadTs(path.relative(ROOT, file));
}

const MUTANTS = [
  { name: 'fix 2: the drain always offers the head (as shipped)', file: 'src/renderer/src/hooks/queueDelivery.ts', real: QUEUE,
    edits: [['  if (!head || head.human || head.manual || !refusedAutomatic.has(head.id)) return head;', '  return head;']],
    killer: 'humanNotHeldBehindRefusedAutomatic', dies: /A PERSON'S MESSAGE IS NOT HELD BEHIND A REFUSED AUTOMATIC ITEM/ },
  { name: 'fix 2 too wide: a person\'s message always jumps the queue', file: 'src/renderer/src/hooks/queueDelivery.ts', real: QUEUE,
    edits: [['  if (!head || head.human || head.manual || !refusedAutomatic.has(head.id)) return head;', '  if (!head || head.human || head.manual) return head;']],
    killer: 'orderUnchangedWhileNothingRefused', dies: /ORDER IS UNCHANGED WHILE NOTHING IS REFUSED/ },
  { name: 'fix 4: an ok reading does not lift the notice (as shipped)', file: 'src/main/codexScreenGuard.ts', real: GUARD,
    edits: [['    if (ok) { this.lift(agentId); return null; }', '    if (ok) return null;']],
    killer: 'noticeLiftsOnOk', dies: /THE NOTICE LIFTS ON THE FIRST OK READING/ },
  { name: 'fix 4: a latch does not lift the notice', file: 'src/main/codexScreenGuard.ts', real: GUARD,
    edits: [['  latched(agentId: string): void {\n    this.lift(agentId);\n  }', '  latched(agentId: string): void {\n    void agentId;\n  }']],
    killer: 'noticeLiftsOnLatch', dies: /THE NOTICE LIFTS ON A LATCH/ },
  { name: 'fix 4: lifting leaves the run alerted (a hold that comes back is silent)', file: 'src/main/codexScreenGuard.ts', real: GUARD,
    edits: [['    this.watch.clear(agentId);\n    this.lastRefusal.delete(agentId);', '    this.lastRefusal.delete(agentId);']],
    killer: 'holdThatComesBackAlertsAgain', dies: /A HOLD THAT COMES BACK ALERTS AGAIN/ },
  { name: 'fix 4: a dismissal covers every later raising', file: 'src/shared/integrityBanner.ts', real: BANNER,
    edits: [["|${issue.error}|${issue.raisedAt ?? ''}`;", '|${issue.error}`;']],
    killer: 'dismissCoversOneRaising', dies: /A NEW RAISING SHOWS AGAIN/ },
  { name: 'fix 4: a damaged file can be dismissed', file: 'src/shared/integrityBanner.ts', real: BANNER,
    edits: [['  return !!issue.notice || issue.repaired === true;', '  return true;']],
    killer: 'pausedIssueNeverDismissed', dies: /A DAMAGED FILE THAT PAUSES CHANGES CANNOT BE DISMISSED/ },
  { name: 'fix 3: the screen hold is not said (as shipped)', file: 'src/shared/deliveryHold.ts', real: HOLD,
    edits: [['  if (i.screenHold) {\n', '  if (i.screenHold && false) {\n']],
    killer: 'screenHoldWorded', dies: /A SCREEN HOLD IS SAID/ },
  { name: 'W1: "send now" offered for a screen hold', file: 'src/shared/deliveryHold.ts', real: HOLD,
    edits: [["        + 'Delivery resumes by itself once the chat box is showing.',\n      action: null", "        + 'Delivery resumes by itself once the chat box is showing.',\n      action: 'SEND_NOW'"]],
    killer: 'screenHoldWorded', dies: /"send now" IS NOT OFFERED for a screen hold/ },
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  fs.rmSync(MUTANT_DIR, { recursive: true, force: true });
  fs.mkdirSync(MUTANT_DIR, { recursive: true });
  try {
    for (const [i, m] of MUTANTS.entries()) {
      await t.test(`mutant: ${m.name}`, async () => {
        const mod = mutate(m.file, m.edits, `m${i}`);
        await K[m.killer](m.real);                    // the killer PASSES on the real module...
        let died = null;
        try { await K[m.killer](mod); } catch (e) { died = e; }
        assert.ok(died, `SURVIVED: "${m.name}" was not killed by ${m.killer}`);
        assert.ok(died instanceof assert.AssertionError, `"${m.name}" must die by ASSERTION, got: ${died && died.stack}`);
        assert.match(died.message, m.dies, `"${m.name}" died at the wrong assertion: ${died.message}`);
      });
    }
  } finally {
    fs.rmSync(MUTANT_DIR, { recursive: true, force: true });
  }
});
