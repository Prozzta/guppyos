'use strict';
/**
 * ZT-I1-MAIL 1.1.75 slice 5: the prompt texts (INBOX-DESIGN.md §5 P1-P12, §11.7, §11.12(c)).
 *  - Injection-mode agents (claude, codex, antigravity) are never told to read, list or MOVE inbox
 *    files: no text they get pairs "move" with inbox/.done.
 *  - Legacy-read agents (gemini, grok, opencode, pi; an agent degraded for "no mail block") keep a
 *    read instruction WITHOUT "move"; no-Stop agents (cursor, an agent degraded for zero hook
 *    traffic: Creed's ruling) keep the 1.1.74 read-and-move text; the terminal work-order agents
 *    get neither (Creed Q26); a degraded agent's nudge says so (Creed Q27).
 *  - P1 carries the §11.12(c) sentence for every agent.
 *  - drainForStop and WORKER_WAKE_NUDGE stay gone (P11, P12).
 * Zero model tokens. HOME, USERPROFILE, CODEX_HOME and GEMINI_CLI_HOME are jailed and asserted first.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mail-prompts-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL; process.env.CODEX_HOME = path.join(JAIL, '.codex'); process.env.GEMINI_CLI_HOME = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const H = loadTs('src/main/hive.ts');
const { HiveManager, protocolLineOne, MAIL_RULES_NOT_IN_MEMORY } = H;
const { mailPromptMode, mailNudgeMode } = loadTs('src/main/mailSurface.ts');
const { inboxNudgeText, inboxWakeTextForProvider, isInboxNudge, INBOX_NUDGE_FIXED_CHARS } = loadTs('src/shared/hiveNudge.ts');
const { readSource, codeOnly } = require('./read-source.cjs');

/** "move" and inbox/.done (any separator) in the same sentence. */
function pairsMoveWithDone(text) {
  return text.split(/(?<=[.!?])\s+|\n/).some((s) => /\bmove/i.test(s) && /\.done/.test(s));
}

async function floor(t) {
  const home = fs.mkdtempSync(path.join(JAIL, 'floor-'));
  const hive = new HiveManager(() => home, () => true);
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  const root = path.join(home, 'hive');
  const promptFor = async (id, provider, extra = {}) => {
    const meta = { id, name: id, provider, cwd: home, ...extra };
    // The agent's folder (and so its ledger) via a claude spawn: no provider CLI, shim or sidecar
    // is ever set up here. The prompt is then built for the provider under test.
    if (!fs.existsSync(path.join(root, 'agents', id))) await hive.ensureAgent({ ...meta, provider: 'claude' });
    return hive.injectedPrompt(meta, path.join(root, 'agents', id), root, false, false);
  };
  return { hive, home, root, promptFor };
}

test('mailPromptMode: inject stays inject; legacy-read stays read unless degraded for zero hook traffic; cursor moves; work orders have their own text (Creed Q26)', () => {
  assert.equal(mailPromptMode('inject', null), 'inject');
  assert.equal(mailPromptMode('legacy-read', null), 'legacy-read');
  assert.equal(mailPromptMode('legacy-read', { mode: 'legacy-read', reason: 'no-mail-block', since: 1 }), 'legacy-read');
  assert.equal(mailPromptMode('legacy-read', { mode: 'legacy-read', reason: 'zero-hook-traffic', since: 1 }), 'legacy-move');
  assert.equal(mailPromptMode('legacy-move', null), 'legacy-move');
  // Creed Q26 (updated from 'legacy-move'): a work-order agent is never told to read or move files.
  assert.equal(mailPromptMode('work-order', null), 'work-order');
});

test('Creed Q27: the wake nudge of a DEGRADED agent says the channel is degraded, and what to do; ASCII and short', () => {
  const zh = { mode: 'legacy-read', reason: 'zero-hook-traffic', since: 1 };
  const nb = { mode: 'legacy-read', reason: 'no-mail-block', since: 1 };
  assert.equal(mailNudgeMode('legacy-read', zh), 'degraded-move');
  assert.equal(mailNudgeMode('legacy-read', nb), 'degraded-read');
  assert.equal(mailNudgeMode('legacy-read', null), 'legacy-read', 'a gemini-style agent is not "degraded"');
  assert.equal(mailNudgeMode('inject', null), 'inject');
  assert.equal(mailNudgeMode('legacy-move', null), 'legacy-move');
  assert.equal(mailNudgeMode('work-order', null), 'work-order');
  const move = inboxNudgeText(['m1'], 'degraded-move');
  assert.equal(move, 'You have new hive mail: m1. Mail channel degraded: read each file in your inbox/ and move it to inbox/.done/ yourself once handled.');
  const read = inboxNudgeText(['m1'], 'degraded-read');
  assert.match(read, /^You have new hive mail: m1\. Mail channel degraded: read those files in your inbox\/ and act; the harness archives them when your turn ends\.$/);
  assert.ok(!pairsMoveWithDone(read));
  for (const t of [move, read]) { assert.match(t, /^[ -~]+$/, 'ASCII'); assert.ok(isInboxNudge(t)); }
  assert.ok(INBOX_NUDGE_FIXED_CHARS <= 160, `${INBOX_NUDGE_FIXED_CHARS}`);
  // A work-order agent's nudge (only if a file ever reached its inbox) never says "move".
  assert.ok(!pairsMoveWithDone(inboxNudgeText(['m1'], 'work-order')));
});

test('P1 line one, per mode, with the §11.12(c) sentence in every one', () => {
  const l = (m) => protocolLineOne(m, false, 'MEM', 'INBOX', 'DONE');
  assert.match(l('inject'), /Messages for you arrive inside your context as a <hive-mail> block; the harness tracks them\. You do not read, list or move inbox files, except to read the rest of a shortened message at the path its block names\. If a message is marked re-delivered, check whether you already handled it\./);
  assert.doesNotMatch(l('inject'), /INBOX|DONE/);
  assert.match(l('legacy-read'), /read EVERY file in INBOX/);
  assert.doesNotMatch(l('legacy-read'), /move|DONE/i);
  assert.match(l('legacy-move'), /read EVERY file in INBOX \(messages other agents sent you\)\. After handling an inbox message, move its file into DONE\./);
  for (const m of ['inject', 'legacy-read', 'legacy-move']) assert.ok(l(m).endsWith(MAIL_RULES_NOT_IN_MEMORY), m);
  assert.equal(MAIL_RULES_NOT_IN_MEMORY, 'Mail handling is defined by the current protocol text, not by your memory: do not record mail-handling rules in memory.md.');
});

test('PIN: no prompt text an injection-mode agent gets pairs "move" with inbox/.done (spawn prompt, nudge, PROTOCOL.md)', async (t) => {
  const { hive, root, promptFor } = await floor(t);
  for (const [id, provider, extra] of [['cl-1', 'claude', {}], ['cx-1', 'codex', {}], ['ag-1', 'antigravity', {}], ['god-1', 'claude', { isGod: true }]]) {
    const p = await promptFor(id, provider, extra);
    assert.ok(!pairsMoveWithDone(p), `${provider}${extra.isGod ? ' (god)' : ''}: ${p.split('\n').find((x) => /move/i.test(x) && /\.done/.test(x))}`);
    assert.doesNotMatch(p, /EVERY file in/, provider);
    assert.match(p, /<hive-mail> block/, provider);
    assert.ok(p.includes(MAIL_RULES_NOT_IN_MEMORY));
  }
  const cx = await promptFor('cx-2', 'codex');
  assert.match(cx, /Codex mail wake: .*<hive-mail> block/);
  assert.doesNotMatch(cx, /read your authoritative inbox/);
  for (const ids of [[], ['a', 'b']]) assert.ok(!pairsMoveWithDone(inboxNudgeText(ids)), 'P4 nudge');
  assert.ok(!pairsMoveWithDone(fs.readFileSync(path.join(root, 'PROTOCOL.md'), 'utf8')), 'PROTOCOL.md (P2/P3)');
  void hive;
});

test('P2/P3: the PROTOCOL template describes inbox/ and .done/ as harness-owned storage, readable for history', async (t) => {
  const { hive, root } = await floor(t);
  hive.ensureHive();
  const p = fs.readFileSync(path.join(root, 'PROTOCOL.md'), 'utf8');
  assert.match(p, /`inbox\/`, `inbox\/\.done\/` — harness-owned storage of the messages addressed to you/);
  assert.match(p, /You may read them for history/);
  assert.match(p, /## Receiving mail\nMessages for you arrive inside your context as a `<hive-mail>` block/);
  assert.match(p, /do not record\nmail-handling rules in memory\.md/);
  assert.doesNotMatch(p, /move a message here/);
});

test('§11.7: legacy-read agents keep a read instruction without "move"; only cursor keeps read-and-move; work-order agents get neither (Creed Q26)', async (t) => {
  const { promptFor } = await floor(t);
  for (const provider of ['gemini', 'grok', 'opencode', 'pi']) {
    const p = await promptFor(`lr-${provider}`, provider);
    assert.match(p, /read EVERY file in .*inbox.* Leave the files where they are: the harness archives each message when your turn ends\./, provider);
    assert.ok(!pairsMoveWithDone(p), provider);
  }
  const cursor = await promptFor('lm-cursor', 'cursor');
  assert.match(cursor, /After handling an inbox message, move its file into .*inbox.\.done\./);
  // Creed Q26 (updated: qwen and kimi used to get read-and-move): every work-order provider.
  for (const provider of ['qwen', 'crush', 'kimi', 'copilot', 'custom']) {
    const p = await promptFor(`wo-${provider}`, provider);
    assert.match(p, /Messages for you are typed into this terminal as hive work orders, each one in full; the harness records them\. You do not read, list or move inbox files\./, provider);
    assert.doesNotMatch(p, /EVERY file in/, provider);
    assert.ok(!pairsMoveWithDone(p), provider);
    assert.ok(p.includes(MAIL_RULES_NOT_IN_MEMORY), provider);
  }
});

test('Creed\'s ruling: an agent degraded for ZERO HOOK TRAFFIC gets the 1.1.74 read-and-move text on its next spawn; one degraded for "no mail block" gets the no-move read text', async (t) => {
  const { hive, promptFor } = await floor(t);
  assert.match(await promptFor('zh-1', 'claude'), /<hive-mail> block/);
  hive.mail.degradeChannel('zh-1', 'zero-hook-traffic');
  const zh = await promptFor('zh-1', 'claude');
  assert.match(zh, /After handling an inbox message, move its file into .*inbox.\.done\./);
  await promptFor('nb-1', 'codex');
  hive.mail.degradeChannel('nb-1', 'no-mail-block');
  const nb = await promptFor('nb-1', 'codex');
  assert.match(nb, /Leave the files where they are/);
  assert.ok(!pairsMoveWithDone(nb));
  assert.match(nb, /Codex inbox wake: .*read your authoritative inbox/, 'a degraded Codex agent reads its inbox on a sentinel wake');
});

test('Q39 (§11.18 #42): a degraded Codex agent\'s alert says "respawn to restore mail delivery"; other providers\' alerts do not; main passes it for codex', async (t) => {
  const { hive, promptFor } = await floor(t);
  await promptFor('cx-9', 'codex');
  await promptFor('cl-9', 'claude');
  assert.equal(hive.mail.degradeChannel('cx-9', 'no-mail-block', {}, { respawnToRestore: true }), true);
  assert.equal(hive.mail.degradeChannel('cl-9', 'no-mail-block', {}), true);
  const notice = (id) => hive.mail.integrityIssues().find((i) => i.error === 'mail-channel-degraded' && i.notice.startsWith(`Mail for ${id} `))?.notice ?? '';
  assert.ok(notice('cx-9').includes('respawn to restore mail delivery'), notice('cx-9'));
  assert.ok(notice('cl-9') && !/respawn/.test(notice('cl-9')), notice('cl-9'));
  const index = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  assert.match(index, /degrade: \(agentId, reason, detail\) => hive\.mail\.degradeChannel\(agentId, reason, detail, \{ respawnToRestore: hive\.registry\(\)\.agents\[agentId\]\?\.provider === 'codex' \}\)/);
});

test('P4: the wake text follows the mode (index.ts wires wakeMailMode); Codex keeps its fixed sentinel', () => {
  assert.equal(inboxWakeTextForProvider('claude', ['m1'], 'inject'), 'You have new hive mail (delivered in context below): m1.');
  assert.equal(inboxWakeTextForProvider('codex', ['m1'], 'inject'), '[hive] check inbox');
  assert.match(inboxWakeTextForProvider('gemini', ['m1'], 'legacy-read'), /^You have new hive mail: m1\. Read those files/);
  assert.match(inboxWakeTextForProvider('cursor', ['m1'], 'legacy-move'), /move handled ones to inbox\/\.done\//);
  const index = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  assert.match(index, /text: \(ids, agentId\) => inboxWakeTextForProvider\(agentId \? hive\.registry\(\)\.agents\[agentId\]\?\.provider : undefined, \[\.\.\.ids\], agentId \? wakeMailMode\(agentId\) : 'inject'\)/);
  // Creed Q27 (updated from mailPromptMode): the nudge mode knows degradation.
  assert.match(index, /function wakeMailMode\(agentId: string\): MailNudgeMode \{[\s\S]*?return mailNudgeMode\(mode, override\);/);
});

test('P7-P10: god, the first god prompt, closing time and the heartbeat say "delivered to you", never "drain your inbox"', () => {
  const hive = readSource('src/main/hive.ts');
  assert.match(hive, /handle the mail delivered to you and triage every other agent/);
  assert.doesNotMatch(hive, /drain your inbox/i);
  // Jim (slices 4/4b/5 follow-up 2): neutral, true in every mail mode (updated from "pending mail is
  // delivered in your context", which is false for a legacy or degraded god).
  // BOOT-REENTER-PASTE-PROOF (1.1.81): the first god prompt's text lives in shared/godOrientation.ts.
  const useHive = readSource('src/shared/godOrientation.ts');
  assert.match(useHive, /'1\. Read your memory\.md; then handle your pending hive mail as your start-up instructions describe\.'/);
  assert.doesNotMatch(useHive, /pending mail is delivered in your context/);
  const closing = readSource('src/main/closingTime.ts');
  assert.match(closing, /a shutdown brief has been delivered to you/);
  assert.doesNotMatch(closing, /drain(ing)? your inbox/i);
  assert.match(readSource('src/main/config.ts'), /Review the digest delivered to you/);
  const index = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  assert.doesNotMatch(index, /Drain your inbox|Undrained inbox/);
});

test('PIN (P11/P12): drainForStop and WORKER_WAKE_NUDGE stay gone', () => {
  for (const f of ['src/main/hive.ts', 'src/main/hooks.ts', 'src/main/index.ts', 'src/main/workerWake.ts']) {
    assert.doesNotMatch(codeOnly(readSource(f), path.basename(f)), /drainForStop|drainLines|WORKER_WAKE_NUDGE/, f);
  }
  assert.equal(typeof HiveManager.prototype.drainForStop, 'undefined');
  assert.equal(H.drainLines, undefined);
  assert.equal(loadTs('src/main/workerWake.ts').WORKER_WAKE_NUDGE, undefined);
});
