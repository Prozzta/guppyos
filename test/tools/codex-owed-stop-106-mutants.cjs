'use strict';

// CODEX-TURN-ENDS-EARLY: the hand-mutant census of the owed-work Stop-continue (P1) and the Codex
// continuation cadence (P2), committed so the audit can re-run it. Each mutant damages ONE source
// line at a unique anchor and must make test/codex-owed-stop-106.test.cjs fail AT ITS OWN NAMED
// TEST; a survivor, a kill elsewhere or a missing anchor fails the census. A heavy job (bench):
// run it in a heavy slot.
//   node test/tools/codex-owed-stop-106-mutants.cjs
// Each file is restored in a finally (CRLF kept).
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const { recover, mutateFile, restoreFile, checkAnchors } = require('./mutant-runner-helper.cjs');
const { runTests, verdict, requireBaseline } = require('./mutant-tap.cjs');
recover(ROOT);
if (process.argv.includes('--recover-only')) process.exit(0);
const TEST = 'test/codex-owed-stop-106.test.cjs';
const STOP = 'src/main/owedStop.ts';
const HOOKS = 'src/main/hooks.ts';
const OWED = 'src/main/owedContinuation.ts';
const INDEX = 'src/main/index.ts';

const MUTANTS = [
  // P1: the decision
  ['S1 Claude and AGY get it too', STOP, "  if (provider !== 'codex') return false;", '  if (!provider) return false;', /not ok \d+ - P1: Codex is on by default/],
  ['S2 {codex:false} does not turn it off', STOP, '.codex === false) return false;', ".codex === 'never') return false;", /not ok \d+ - P1: Codex is on by default/],
  ['S3 the reason does not say to go on', STOP, 'is still owed. Do the next step now. End', 'is still owed. End', /not ok \d+ - P1: a shown request still owed blocks/],
  ['S4 a 5th block per chain', STOP, '(chain.get(o.id) ?? 0) < OWED_STOP_MAX', '(chain.get(o.id) ?? 0) <= OWED_STOP_MAX', /not ok \d+ - P1: the cap is 4/],
  ['S5 a Stop that goes through never ends the chain', STOP, '      this.chains.delete(agentId);\n', '', /not ok \d+ - P1: the cap is 4/],
  ['S6 the newest obligation first', STOP, '.sort((a, b) => a.deliveredAt - b.deliveredAt || a.seq - b.seq);', '.sort((a, b) => b.deliveredAt - a.deliveredAt || b.seq - a.seq);', /not ok \d+ - P1: with two obligations/],
  ['S7 a tool-free segment is blocked', STOP, "    if (segmentTools < 1) return pass('no-tools');\n", '', /not ok \d+ - P1: a tool-free segment is never blocked/],
  ['S8 waiting mail does not hold it', STOP, "    if (f.pendingMail > 0) return pass('pending-mail');\n", '', /not ok \d+ - P1: every legitimate wait/],
  ['S9 the legitimate waits are skipped', STOP, '    const why = owedSuppressor(f);', '    const why = null as OwedSuppressor | null;', /not ok \d+ - P1: every legitimate wait/],
  ['S10 no PTY does not hold it', STOP, "    if (!f.pty) return pass('no-pty');\n", '', /not ok \d+ - P1: every legitimate wait/],
  ['S11 an inhibited PTY does not hold it', STOP, "    if (f.inhibited) return pass('inhibited');\n", '', /not ok \d+ - P1: every legitimate wait/],
  ['S12 a picker does not hold it', STOP, "f.promptBlock === 'draft' || f.promptBlock === 'picker' || ", "f.promptBlock === 'draft' || ", /not ok \d+ - P1: every legitimate wait/],
  ['S13 a key 1.5 s ago still holds it', STOP, 'f.now - f.lastHumanInputAt < OWED_STOP_HUMAN_QUIET_MS', 'f.now - f.lastHumanInputAt <= OWED_STOP_HUMAN_QUIET_MS', /not ok \d+ - P1: every legitimate wait/],
  ['S14 a request only delivered is owed', STOP, "e.state !== 'delivered' && ", '', /not ok \d+ - P1: what is owed/],
  ['S15 the backlog before the app start is owed', STOP, ' && (e.actedAt ?? e.surfacingAt ?? e.updatedAt ?? 0) >= since', '', /not ok \d+ - P1: what is owed/],
  ['S16 an inform reply discharges', STOP, ' && owesWork(e)\n', ' && !e.repliedAt\n', /not ok \d+ - P1: what is owed/],
  ['S17 the window edge is out', STOP, 'e.deliveredAt >= now - OWED_WINDOW_MS', 'e.deliveredAt > now - OWED_WINDOW_MS', /not ok \d+ - P1: what is owed/],
  // P1: the HookServer Stop
  ['H1 the Stop never asks', HOOKS, '        try { stopReason = this.owedStopReason(agentId, p, segmentTools); } catch { stopReason = null; }\n', '', /not ok \d+ - P1 HookServer: a Codex Stop after a tool call/],
  ['H2 the segment mark never moves', HOOKS, '      if (!straggler) this.segmentMark.set(agentId, tools);\n', '', /not ok \d+ - P1 HookServer: a Codex Stop after a tool call/],
  ['H3 an owed block counts as a mail block', HOOKS, '      if (!owedBlock) { try { this.coordination?.onMailBlock?.(agentId); }', '      if (true) { try { this.coordination?.onMailBlock?.(agentId); }', /not ok \d+ - P1 HookServer: a Codex Stop after a tool call/],
  ['H4 a straggler Stop moves the mark', HOOKS, '      if (!straggler) this.segmentMark.set', '      this.segmentMark.set', /not ok \d+ - P1 HookServer: a subagent Stop/],
  // No 'a straggler Stop is asked' row: owedStopReason already refuses a Stop naming another turn
  // (turnId vs epoch), so a guard on the call was redundant and is gone (a mutant could only kill a pin).
  ['H6 a one-way pipe is asked', HOOKS, "    if (!os || p.transport === 'pipe-oneway') return null;", '    if (!os) return null;', /not ok \d+ - P1 HookServer: a subagent Stop/],
  ['H7 a Stop with no open turn is asked', HOOKS, "    if (!t?.open || (turnId && t.epoch !== turnId)) return null;\n    // A Codex agent degraded", "    if (turnId && t && t.epoch !== turnId) return null;\n    // A Codex agent degraded", /not ok \d+ - P1 HookServer: a subagent Stop/],
  ['H9 a legacy-read Codex channel is asked', HOOKS, "    if (channel.mode !== 'inject') return null;\n    return os.decide", '    return os.decide', /not ok \d+ - P1 HookServer: a subagent Stop/],
  ['H8 the M4 mail block can be overridden', HOOKS, '      if (stopReason === null) {\n        try { stopReason = this.owedStopReason', '      if (true) {\n        try { stopReason = this.owedStopReason', /not ok \d+ - wiring:/],
  // P2: the Codex cadence
  ['P1 no 5 min repeat', OWED, '(working(t) ? OWED_REPEAT_CODEX_MS : OWED_REPEAT_MS)', 'OWED_REPEAT_MS', /not ok \d+ - P2: a working Codex agent/],
  ['P2 Claude gets the fast cadence', OWED, "f.provider === 'codex' && tools > t.toolsAt", 'tools > t.toolsAt', /not ok \d+ - P2: Claude and AGY keep/],
  ['P3 no tool call counts as work', OWED, "f.provider === 'codex' && tools > t.toolsAt", "f.provider === 'codex' && tools >= t.toolsAt", /not ok \d+ - P2: no tool call since/],
  ['P4 the tally forgets where it was', OWED, 'gaveUp: false, toolsAt: tools }', 'gaveUp: false, toolsAt: 0 }', /not ok \d+ - P2: no tool call since/],
  ['P5 a 7th continuation', OWED, 'export const OWED_MAX_CODEX = 6;', 'export const OWED_MAX_CODEX = 7;', /not ok \d+ - P2: a working Codex agent/],
  ['P6 the repeat at 4 min', OWED, 'export const OWED_REPEAT_CODEX_MS = 5 * 60_000;', 'export const OWED_REPEAT_CODEX_MS = 4 * 60_000;', /not ok \d+ - P2: a working Codex agent/],
  ['P7 the STALL says 2', OWED, '      const continuations = Math.max(...spent.map((e) => tallies.get(e.id)?.count ?? 0));', '      const continuations = OWED_MAX;', /not ok \d+ - P2: a working Codex agent/],
  ['P8 the fast cadence skips the new-Stop rule', OWED, '(!t.gaveUp && f.lastTurnEndAt > t.lastAt && f.now', '(!t.gaveUp && (working(t) || f.lastTurnEndAt > t.lastAt) && f.now', /not ok \d+ - P2: the 5 min repeat still waits/],
  // the wiring
  ['I1 the beat passes no provider', INDEX, '        provider: hookServer.mailChannel(agentId).provider ?? null,', '        provider: null,', /not ok \d+ - wiring:/],
  ['I2 the beat passes no tool calls', INDEX, '        toolCalls: hookServer.toolCallCount(agentId)', '        toolCalls: 0', /not ok \d+ - wiring:/],
  ['I3 the setting is never read', INDEX, 'readConfig().owedStopContinue', 'undefined', /not ok \d+ - wiring:/],
  ['I5 an agent with no PTY counts as having one', INDEX, '        pty: !!ptyId,', '        pty: true,', /not ok \d+ - wiring:/],
  ['I6 the prompt block (draft/picker/exited) is never passed', INDEX, '        ...(s?.block ? { promptBlock: s.block } : {}),\n', '', /not ok \d+ - wiring:/],
  ['I4 the decision is never wired', INDEX, 'hookServer.setOwedStop({ decide: (agentId, provider, segmentTools) => decideOwedStop(agentId, provider, segmentTools) });', '', /not ok \d+ - wiring:/]
];

checkAnchors(ROOT, MUTANTS.map(([name, file, from]) => ({ name, file, from })));
const run = () => runTests(ROOT, [TEST], { timeout: 300_000 });
requireBaseline(run(), TEST);

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
  const v = verdict(r, dies); // NO-RESULT (the run never reported) is loud, never a kill
  if (v !== 'KILLED') bad += 1;
  console.log(`${v} ${name}${v === 'NO-RESULT' ? ` (${r.why})` : ''}`);
}
console.log(bad ? `${bad} of ${MUTANTS.length} not killed at their named test` : `all ${MUTANTS.length} killed`);
process.exitCode = bad ? 1 : 0;
