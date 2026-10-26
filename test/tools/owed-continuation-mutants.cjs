'use strict';

// HIVE-DWIGHT-BG-REINVOKE: the hand-mutant census of the owed-work continuation, committed so the
// audit can re-run it. Each mutant damages ONE source line at a unique anchor and must make
// test/owed-continuation-198.test.cjs fail AT ITS OWN NAMED TEST; a survivor, a kill elsewhere or a
// missing anchor fails the census. A heavy job (bench): run it in a heavy slot.
//   node test/tools/owed-continuation-mutants.cjs
// Each file is restored in a finally (CRLF kept).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const { recover, mutateFile, restoreFile } = require('./mutant-runner-helper.cjs');
recover(ROOT);
if (process.argv.includes('--recover-only')) process.exit(0);
const TEST = 'test/owed-continuation-198.test.cjs';
const OWED = 'src/main/owedContinuation.ts';
const LEDGER = 'src/main/mailLedger.ts';
const HIVE = 'src/main/hive.ts';
const INDEX = 'src/main/index.ts';
const TERM = 'src/main/termControl.ts';
const DIGEST = 'src/main/floorDigest.ts';

const MUTANTS = [
  ['M1 a done never upgrades an interim reply', LEDGER, 'const discharging = !!replyAct && DISCHARGING_REPLY_ACTS.has(replyAct);', 'const discharging = false;', /not ok \d+ - OWED A: a later done upgrades/],
  ['M2 blocked does not discharge', LEDGER, "new Set(['done', 'refuse', 'blocked'])", "new Set(['done', 'refuse'])", /not ok \d+ - OWED A: an inform, agree or onward request/],
  ['M2b only inform and agree are interim (an onward request discharges)', LEDGER, '!!e.replyAct && !DISCHARGING_REPLY_ACTS.has(e.replyAct)', "['inform', 'agree'].includes(e.replyAct ?? '')", /not ok \d+ - OWED A: an inform, agree or onward request/],
  ['M3 an interim reply discharges (the old rule)', LEDGER, '  return isOpenObligation(e) || isInterimReplied(e);', '  return isOpenObligation(e);', /not ok \d+ - OWED REPLAY 02:59Z: a request answered only with an inform/],
  ['M4 the rebuild drops the act', LEDGER, "replyAct: typeof r.replyAct === 'string' ? r.replyAct : null }", 'replyAct: null }', /not ok \d+ - OWED A: the rebuild restores the act/],
  ['M5 needs_human is not blocked', HIVE, "msg.needs_human === true ? 'blocked' : msg.act", 'msg.act', /not ok \d+ - OWED A: hive routes needs_human as blocked/],
  ['M6 a dismiss misses an interim reply', LEDGER, 'const e = resolveEntries(doc, ref).find((c) => owesWork(c));', 'const e = resolveEntries(doc, ref).find((c) => isOpenObligation(c));', /not ok \d+ - OWED A: a dismiss, a supersede or a cited done/],
  ['M7 a cited done misses an interim reply', LEDGER, 'filter((e) => e.from === requester && owesWork(e) && e.deliveredAt < m.at).sort(bySeq);', 'filter((e) => e.from === requester && isOpenObligation(e) && e.deliveredAt < m.at).sort(bySeq);', /not ok \d+ - OWED A: a dismiss, a supersede or a cited done/],
  ['M8 a supersede misses an interim reply', LEDGER, 'e.from === requester && owesWork(e) && e.deliveredAt < m.at && (named.has(e.id)', 'e.from === requester && isOpenObligation(e) && e.deliveredAt < m.at && (named.has(e.id)', /not ok \d+ - OWED A: a dismiss, a supersede or a cited done/],
  ['M9 the ledger close misses an interim ask', HIVE, "if (own && owesWork(own)) return { by: 'owner', open: [caller] };", "if (own && isOpenObligation(own)) return { by: 'owner', open: [caller] };", /not ok \d+ - OWED A: hive routes needs_human as blocked/],
  ['M10 no grace', OWED, 'f.now - f.lastTurnEndAt < OWED_GRACE_MS)', 'f.now - f.lastTurnEndAt < 0)', /not ok \d+ - OWED REPLAY 07:18Z/],
  ['M11 submits into an active agent', OWED, "if (f.lifecycle !== 'idle' || f.inFlight", 'if (f.inFlight', /not ok \d+ - OWED GUARD/],
  ['M12 ignores mail pending', OWED, ' || f.pendingMail > 0 ||', ' ||', /not ok \d+ - OWED GUARD/],
  ['M13 ignores pause', OWED, "  if (f.paused) return 'paused';\n", '', /not ok \d+ - OWED SUPPRESS: a legitimate wait/],
  ['M14 ignores halt', OWED, "  if (f.halted) return 'halted';\n", '', /not ok \d+ - OWED SUPPRESS: a legitimate wait/],
  ['M15 ignores the heavy queue', OWED, "  if (f.heavyQueued) return 'heavy-queued';\n", '', /not ok \d+ - OWED SUPPRESS: a legitimate wait/],
  ['M16 ignores its own open request', OWED, "  if (recent.some((s) => s.act === 'request' && s.open)) return 'outgoing-request';\n", '', /not ok \d+ - OWED SUPPRESS: a legitimate wait/],
  ['M17 an outgoing request never ages out', OWED, 'const recent = f.sent.filter((s) => s.at >= f.now - OWED_WINDOW_MS);', 'const recent = f.sent;', /not ok \d+ - OWED SUPPRESS: an older request/],
  ['M18 an answered request still holds it back', OWED, " && !f.entries.some((e) => e.from !== 'system' && e.deliveredAt > newest.at)) return 'newest-sent-request';", ") return 'newest-sent-request';", /not ok \d+ - OWED SUPPRESS: an older request/],
  ['M19 a suppressed row every beat', OWED, '      if (this.lastSuppressed.get(agentId) === key) return { rows: [] };\n', '', /not ok \d+ - OWED SUPPRESS: a legitimate wait/],
  ['M20 a repeat without a new Stop', OWED, '(!t.gaveUp && f.lastTurnEndAt > t.lastAt && ', '(!t.gaveUp && ', /not ok \d+ - OWED CAP: one per obligation per hour/],
  ['M21 a third continuation', OWED, '(tallies.get(e.id)?.count ?? 0) >= OWED_MAX);', '(tallies.get(e.id)?.count ?? 0) > OWED_MAX);', /not ok \d+ - OWED CAP: one per obligation per hour/],
  ['M22 the backlog floods at upgrade', OWED, ' && (e.actedAt ?? 0) >= since', '', /not ok \d+ - OWED SCOPE/],
  ['M23 system mail counts', OWED, "e.act === 'request' && e.from !== 'system' && ", "e.act === 'request' && ", /not ok \d+ - OWED SCOPE/],
  ['M24 god told about itself', OWED, '      if (god && god !== agentId) {', '      if (god) {', /not ok \d+ - OWED CAP: no god notice/],
  ['M25 the beat never runs it', INDEX, '  runOwedContinuation(live);\n', '', /not ok \d+ - OWED WIRING/],
  ['M26 a reservation is not a heavy wait', INDEX, ' || q.reserved.some((r) => r.agentId === agentId),', ',', /not ok \d+ - OWED WIRING/],
  // Jim 0dbf11 / god 911143: the floor hold, the heavy holder, the protocol rule.
  ['M27 the floor hold is ignored', OWED, "  if (f.floorHeld) return 'floor-paused';\n", '', /not ok \d+ - OWED FLOOR HOLD 12:26Z/],
  ['M28 the heavy holder is ignored', OWED, "  if (f.heavyHolder) return 'heavy-holder';\n", '', /not ok \d+ - OWED SUPPRESS: a legitimate wait/],
  ['M29 the beat never sees a holder', INDEX, 'heavyHolder: holders.some((h) => h.agentId === agentId),', 'heavyHolder: false,', /not ok \d+ - OWED WIRING/],
  ['M30 the beat never sees the hold', INDEX, 'const floorHeld = parseFloorHold(readConfig().floorHold) !== null;', 'const floorHeld = false;', /not ok \d+ - OWED WIRING/],
  ['M31 term hold saves nothing', TERM, 'try { store.set(next); }', 'try { void next; }', /not ok \d+ - OWED FLOOR HOLD: god-only, persisted/],
  ['M32 term hold is not god-only', TERM, "    if (!god || callerId !== god) return refuse(403, 'term is god-only');\n    if (b.action === 'hold')", "    if (b.action === 'hold') return Promise.resolve(this.hold(callerId, b, refuse));\n    if (!god || callerId !== god) return refuse(403, 'term is god-only');\n    if (b.action === 'hold')", /not ok \d+ - OWED FLOOR HOLD: god-only, persisted/],
  ['M33 a repeat on restarts the hold', TERM, "if (b.state === 'on' && cur) {", 'if (false) {', /not ok \d+ - OWED FLOOR HOLD: god-only, persisted/],
  ['M34 the digest hides the hold', DIGEST, '  if (input.floorHold) out.push(', '  if (false) out.push(', /not ok \d+ - OWED FLOOR HOLD: the term CLI/],
  ['M35 fleet.json hides the hold', INDEX, ', floorHold: hold ? { ...hold, line: floorHoldWords(hold, now) } : null });', ' });', /not ok \d+ - OWED FLOOR HOLD: the term CLI/],
  ['M36 the protocol lets an inform discharge', HIVE, 'act \\`done\\` or \\`refuse\\`, or with', 'act \\`done\\`, \\`inform\\` or \\`refuse\\`, or with', /not ok \d+ - OWED PROTOCOL/],
  ['M37 the allow-list drifts from the protocol', LEDGER, "new Set(['done', 'refuse', 'blocked'])", "new Set(['done', 'refuse', 'blocked', 'agree'])", /not ok \d+ - OWED PROTOCOL/],
  ['M38 the nudge does not say how to close', OWED, 'If this is finished, reply done with in_reply_to <id>', 'Continue', /not ok \d+ - OWED PROTOCOL/]
];

const run = () => spawnSync(process.execPath, ['--test', TEST], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 300_000 });
if (run().status !== 0) {
  console.log(`BASELINE RED: ${TEST} fails unmutated, so no mutant proves anything.`);
  process.exit(2);
}

let bad = 0;
for (const [name, rel, from, to, dies] of MUTANTS) {
  const abs = path.join(ROOT, rel);
  const original = fs.readFileSync(abs, 'utf8');
  const source = original.replace(/\r\n/g, '\n');
  const at = source.indexOf(from);
  if (at < 0 || source.indexOf(from, at + 1) >= 0) {
    console.log(`INERT ${name} (anchor ${at < 0 ? 'missing' : 'not unique'})`);
    bad += 1;
    continue;
  }
  let mutated = source.slice(0, at) + to + source.slice(at + from.length);
  if (original.includes('\r\n')) mutated = mutated.replace(/\n/g, '\r\n');
  let r;
  try {
    mutateFile(ROOT, abs, original, mutated);
    r = run();
  } finally {
    restoreFile(ROOT, abs, original);
  }
  const named = dies.test(`${r.stdout}${r.stderr}`);
  const killed = r.status !== 0 && named;
  if (!killed) bad += 1;
  console.log(`${killed ? 'KILLED' : r.status !== 0 ? 'KILLED ELSEWHERE' : 'SURVIVED'} ${name}`);
}
console.log(bad ? `${bad} of ${MUTANTS.length} not killed at their named test` : `all ${MUTANTS.length} killed`);
process.exitCode = bad ? 1 : 0;
