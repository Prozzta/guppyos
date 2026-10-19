'use strict';

/**
 * Mutant runner for GTC M4 (design section 15, 15.10): the term-path WakeSender and the
 * Stop-continue. Each mutant injects ONE named regression into ONE source file, runs the M4 test
 * files, and must turn them RED. An anchor that is missing or not unique is INERT and counts as a
 * failure of the run. Same engine as inbox-wake-mutants.cjs. HEAVY: run it in the heavy slot.
 *
 *   node test/tools/gtc-m4-mutants.cjs [name-prefix]
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const TESTS = ['test/gtc-m4-wake-197.test.cjs', 'test/hook-broker-p4.test.cjs', 'test/mail-epochs.test.cjs', 'test/inbox-wake-bridge.test.cjs', 'test/worker-wake.test.cjs'];
const HOOKS = 'src/main/hooks.ts';
const SEND = 'src/main/wakeSender.ts';
const WAKE = 'src/main/workerWake.ts';
const BRIDGE = 'src/main/inboxWakeBridge.ts';
const HIVE = 'src/main/hive.ts';
const OWNER = 'src/main/automaticSubmit.ts';

const MUTANTS = [
  // — the Stop-continue in HookServer (MUST 2, MUST 3, guards) —
  ['a a blocked Stop reaches the coordinator as a turn end', HOOKS,
    'stopReason !== null ? false : typeof p.fully_idle', 'typeof p.fully_idle'],
  ['h a blocked Stop closes its epoch', HOOKS,
    'if (agentId && !fromSubagent && stopReason === null) this.trackTurn(agentId, event, p);',
    'if (agentId && !fromSubagent) this.trackTurn(agentId, event, p);'],
  ['h the continued turn\'s Stop is blocked again (guard 1)', HOOKS,
    'if (!sc || p.stop_hook_active || p.fully_idle === false', 'if (!sc || p.fully_idle === false'],
  ['h one turn is blocked twice (guard 4)', HOOKS,
    ' || this.stopBlocked.get(agentId) === t.epoch) return null;', ') return null;'],
  ['h an AGY mid-chain Stop is blocked (guard 7)', HOOKS,
    'if (!sc || p.stop_hook_active || p.fully_idle === false || ', 'if (!sc || p.stop_hook_active || '],
  ['h headers alone block the Stop', HOOKS,
    'const blocked = !!reason && this.mailClaims.length > before;', 'const blocked = !!reason;'],
  ['h the Codex Stop reason has no budget cap (CODEX-BLOAT-165)', HOOKS,
    "channel.provider === 'codex' ? CODEX_STOP_MAIL_BUDGET : undefined", 'undefined'],
  ['h a Stop that did not block never settles its claim', HOOKS,
    'try { sc.stopSettle(agentId, claim.requestId, blocked,', 'try { if (blocked) sc.stopSettle(agentId, claim.requestId, blocked,'],
  ['h the Stop reason is not the mail (the bare nudge)', HOOKS,
    "      reason = this.surfaceMail(agentId, 'Stop', p, channel.provider, [], channel.provider === 'codex' ? CODEX_STOP_MAIL_BUDGET : undefined);",
    "      reason = this.surfaceMail(agentId, 'Stop', p, channel.provider, [], channel.provider === 'codex' ? CODEX_STOP_MAIL_BUDGET : undefined) === null ? null : 'You have new hive mail';"],
  ['h a blocked Stop is answered as non-blocking', HOOKS,
    "      return { decision: 'block', reason: stopReason };", '      return {};'],
  ['s the AGY shim answers a Stop block with block (a hard stop for AGY)', HIVE,
    "out = { decision: 'continue', reason: r.reason };", "out = { decision: 'block', reason: r.reason };"],
  // — the coordinator (MUST 3) —
  ['b a Stop-continue epoch re-pends at 60 s (Jim MUST 3: doubleSubmit)', WAKE,
    '(r.viaStop ? STOP_CONFIRM_MS : SUBMIT_CONFIRM_MS)', 'SUBMIT_CONFIRM_MS'],
  ['c the settle forgets the epoch came from a Stop', WAKE,
    '      r.viaStop = viaStop;\n', ''],
  ['c the bridge settles a Stop-continue as a typed wake', BRIDGE,
    'this.deps.coordinator.settle(claim, kind, this.deps.now(), blocked, blocked);',
    'this.deps.coordinator.settle(claim, kind, this.deps.now(), blocked, false);'],
  ['c an unconfirmed Stop-continue epoch leaves a recheck (Jim 24e45c)', WAKE,
    'if (r.provisional && r.commitIds.length && !r.viaStop) r.recheck = r.commitIds;',
    'if (r.provisional && r.commitIds.length) r.recheck = r.commitIds;'],
  ['c a blocked Stop settles REFUSED (the ids go back to pending)', BRIDGE,
    "const kind = blocked ? 'COMMITTED' : 'REFUSED';", "const kind = 'REFUSED';"],
  // — the WakeSender: DELIVERED (MUST 1, SHOULD 2) —
  ['m MUST 1: the wake match is the 64-char head', SEND,
    'return want.length > 0 && norm(prompt).includes(want);',
    'return want.length > 0 && norm(prompt).slice(0, 64) === want.slice(0, 64);'],
  ['m the sentinel confirm claims the send id (not by-writer)', SEND,
    "else if (norm(prompt) === CODEX_INBOX_WAKE_SENTINEL) this.confirm(agentId, p, 'DELIVERED', 'writer');",
    "else if (norm(prompt) === CODEX_INBOX_WAKE_SENTINEL) this.confirm(agentId, p, 'DELIVERED', 'send-id');"],
  ['m a person\'s Codex prompt confirms the wake', SEND,
    "else if (norm(prompt) === CODEX_INBOX_WAKE_SENTINEL) this.confirm(agentId, p, 'DELIVERED', 'writer');",
    "else this.confirm(agentId, p, 'DELIVERED', 'writer');"],
  ['m an orphan sentinel goes unlogged', SEND,
    "        this.row({ kind: 'wake-confirm-orphan', agentId, event });\n", ''],
  ['m the stop confirm times out at the wake window', SEND,
    "const ms = p.kind === 'stop' ? STOP_CONFIRM_MS :", "const ms = p.kind === 'stop' ? WAKE_CONFIRM_MS :"],
  ['m the stop wake is never confirmed by the continued turn', SEND,
    "|| event === 'PreToolUse' || event === 'PostToolUse' || event === 'PreInvocation') {",
    "|| event === 'PreInvocation') {"],
  ['m doubleSubmit misses a wake still awaiting its confirm', SEND,
    "\n      || (prior !== undefined && !prior.done && prior.kind !== 'boot' && idSetOf(prior.requestId) === ids)) {", ') {'],
  // — the WakeSender: the send —
  ['t a person\'s key in the gap is Entered anyway', SEND,
    'if (gen0 === undefined || gen1 !== gen0) return this.typedNotSent', 'if (gen0 === undefined) return this.typedNotSent'],
  ['t no composer check before the Enter', SEND, '    if (!onPrompt) {\n', '    if (false) {\n'],
  ['t the gates do not run again inside the slot', SEND,
    "    const again = this.gates(req, kind, ptyId, provider, kind === 'boot');", '    const again = null;'],
  ['t the grant is never confirmed after the Enter', SEND,
    '    if (decision !== null) { try { d.confirmLaunch(decision); } catch { /* capacity bookkeeping only */ } }\n', ''],
  ['t a capacity refusal keeps the grant', SEND,
    "      if (!adm.proceed) { this.cancel(decision); return this.refuse(req, kind, 'CAPACITY_HOLD', adm.basis); }",
    "      if (!adm.proceed) { return this.refuse(req, kind, 'CAPACITY_HOLD', adm.basis); }"],
  ['t a typed-not-sent wake is not held', SEND,
    '    try { this.d.holdTyped(ptyId, req, held, reason); } catch { /* the outcome still says INTERFERED */ }\n', ''],
  ['t a typed answer is not replayed (typed twice)', SEND,
    '        this.answered.set(req.requestId, { outcome: o, at: this.d.now() });\n', ''],
  ['t a released hold is replayed forever (the mail never wakes again)', SEND,
    "if (k.kind === 'INTERFERED' && pty && !this.d.inhibited(pty)) {", 'if (false) {'],
  ['t an unknown lifecycle waits in the dark (Q3)', SEND,
    "return this.viaOwner(req, kind, 'lifecycle-unknown');", "return this.refuse(req, kind, 'NOT_IDLE', 'unknown');"],
  ['t the shadow decides', SEND,
    '    const screen = shadowClass(this.sd, provider, ptyId);\n',
    "    const screen = shadowClass(this.sd, provider, ptyId);\n    if ((await screen) !== 'READY') return this.refuse(req, kind, 'SCREEN');\n"],
  ['t the owner path is not byte for byte', SEND,
    "    if (path === 'owner') return this.d.ownerSubmit(req);", "    if (path === 'owner') return this.d.ownerSubmit({ ...req });"],
  // — boot (SHOULD 1) —
  ['k a Claude boot skips the 1 s settle', SEND, 'now - at >= WAKE_BOOT_SETTLE_MS', 'now - at >= 0'],
  ['k a Codex boot is typed on the term path', SEND,
    "    if (provider === 'codex') return { ready: false, at: 0, owner: 'boot-codex-lazy-session-start' };\n", ''],
  ['k no ready event never falls back to the owner', SEND,
    "    if (now - spawned >= WAKE_BOOT_READY_MS) return { ready: false, at: 0, owner: 'boot-no-ready-event' };\n", ''],
  ['k a boot not in the composer is held as a person\'s', SEND,
    '      if (kind === \'boot\') {\n        // Our text may be on the screen', '      if (false) {\n        // Our text may be on the screen'],
  ['k a handed boot is typed here again', SEND,
    '    if (handed) return this.d.ownerSubmit(handed.req);\n', ''],
  // — the Stop claim (guards 3 and 6, the flags) —
  ['g a draft at the Stop is overwritten by a continue', SEND,
    "if (block === 'draft' || block === 'picker' || block === 'exited') return null;", "if (block === 'picker' || block === 'exited') return null;"],
  ['g a person\'s recent key at the Stop is ignored', SEND,
    '    if (last !== undefined && d.now() - last < HUMAN_QUIET_MS) return null;\n    let adm', '    let adm'],
  ['g the Stop-continue ignores the path', SEND, "  if (path !== 'term' || !v ||", '  if (!v ||'],
  ['g a failed Stop claim keeps the grant', SEND,
    '    if (!claim) { this.cancel(adm.decision); return null; }', '    if (!claim) { return null; }'],
  // — the owner's hold —
  ['o a typed hold binds no payload (ALREADY_HANDLED mismatches)', OWNER,
    'binding: { agentId: req.agentId, admissionClass: req.admissionClass, payload: payloadIdentity(req.text) },\n      decision: null',
    "binding: { agentId: req.agentId, admissionClass: req.admissionClass, payload: '' },\n      decision: null"],
  ['o the recheck erases our typed text', OWNER,
    "    if (held.reason === 'WAKE_TYPED_NOT_SENT') return stay('typed-not-sent');\n", '']
];

// THE BASELINE MUST BE GREEN.
const baseline = spawnSync(process.execPath, ['--test', ...TESTS], { cwd: ROOT, encoding: 'utf8' });
if (baseline.status !== 0) {
  console.log('BASELINE RED: the unmutated M4 tests fail, so no mutant result would mean anything.');
  process.exit(2);
}

const only = process.argv[2];
const selected = MUTANTS.filter(([name]) => !only || name.startsWith(only));
let killed = 0;
let inert = 0;
for (const [name, file, from, to] of selected) {
  const abs = path.join(ROOT, file);
  const original = fs.readFileSync(abs, 'utf8');
  const crlf = original.includes('\r\n');
  const lf = original.replace(/\r\n/g, '\n');
  const at = lf.indexOf(from);
  if (at < 0 || lf.indexOf(from, at + 1) >= 0) {
    inert++;
    console.log(`INERT     ${name}  (anchor ${at < 0 ? 'missing' : 'not unique'} in ${file})`);
    continue;
  }
  let mutated = lf.slice(0, at) + to + lf.slice(at + from.length);
  if (crlf) mutated = mutated.replace(/\n/g, '\r\n');
  try {
    fs.writeFileSync(abs, mutated);
    const r = spawnSync(process.execPath, ['--test', ...TESTS], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
    const fails = (String(r.stdout).match(/^# fail (\d+)/m) || [])[1] ?? '?';
    const dead = r.status !== 0;
    if (dead) killed++;
    console.log(`${dead ? 'KILLED  ' : 'SURVIVED'}  ${name}  (failing tests: ${fails})`);
  } finally {
    fs.writeFileSync(abs, original);
  }
}
console.log(`\n${killed}/${selected.length} killed${inert ? `, ${inert} INERT` : ''}`);
process.exit(killed === selected.length ? 0 : 1);
