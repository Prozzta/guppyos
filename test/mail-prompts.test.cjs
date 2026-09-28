'use strict';
/**
 * ZT-I1-MAIL 1.1.75 slice 5: the prompt texts (INBOX-DESIGN.md §5 P1-P12, §11.7, §11.12(c)).
 *  - Injection-mode agents (claude, codex, antigravity) are never told to read, list or MOVE inbox
 *    files: no text they get pairs "move" with inbox/.done.
 *  - Legacy-read agents (gemini, grok, opencode, pi; an agent degraded for "no mail block") keep a
 *    read instruction WITHOUT "move"; no-Stop agents (cursor, the terminal work-order agents, an
 *    agent degraded for zero hook traffic: Creed's ruling) keep the 1.1.74 read-and-move text.
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
const { mailPromptMode } = loadTs('src/main/mailSurface.ts');
const { inboxNudgeText, inboxWakeTextForProvider } = loadTs('src/shared/hiveNudge.ts');
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

test('mailPromptMode: inject stays inject; legacy-read stays read unless degraded for zero hook traffic; no-Stop modes move', () => {
  assert.equal(mailPromptMode('inject', null), 'inject');
  assert.equal(mailPromptMode('legacy-read', null), 'legacy-read');
  assert.equal(mailPromptMode('legacy-read', { mode: 'legacy-read', reason: 'no-mail-block', since: 1 }), 'legacy-read');
  assert.equal(mailPromptMode('legacy-read', { mode: 'legacy-read', reason: 'zero-hook-traffic', since: 1 }), 'legacy-move');
  assert.equal(mailPromptMode('legacy-move', null), 'legacy-move');
  assert.equal(mailPromptMode('work-order', null), 'legacy-move');
});

test('P1 line one, per mode, with the §11.12(c) sentence in every one', () => {
  const l = (m) => protocolLineOne(m, false, 'MEM', 'INBOX', 'DONE');
  assert.match(l('inject'), /Messages for you arrive inside your context as a <hive-mail> block; the harness tracks them\. You do not read, list or move inbox files\. If a message is marked re-delivered, check whether you already handled it\./);
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

test('§11.7: legacy-read agents keep a read instruction without "move"; cursor and the work-order agents keep read-and-move', async (t) => {
  const { promptFor } = await floor(t);
  for (const provider of ['gemini', 'grok', 'opencode', 'pi']) {
    const p = await promptFor(`lr-${provider}`, provider);
    assert.match(p, /read EVERY file in .*inbox.* Leave the files where they are: the harness archives each message when your turn ends\./, provider);
    assert.ok(!pairsMoveWithDone(p), provider);
  }
  for (const provider of ['cursor', 'qwen', 'kimi']) {
    const p = await promptFor(`lm-${provider}`, provider);
    assert.match(p, /After handling an inbox message, move its file into .*inbox.\.done\./, provider);
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

test('P4: the wake text follows the mode (index.ts wires wakeMailMode); Codex keeps its fixed sentinel', () => {
  assert.equal(inboxWakeTextForProvider('claude', ['m1'], 'inject'), 'You have new hive mail (delivered in context below): m1.');
  assert.equal(inboxWakeTextForProvider('codex', ['m1'], 'inject'), '[hive] check inbox');
  assert.match(inboxWakeTextForProvider('gemini', ['m1'], 'legacy-read'), /^You have new hive mail: m1\. Read those files/);
  assert.match(inboxWakeTextForProvider('cursor', ['m1'], 'legacy-move'), /move handled ones to inbox\/\.done\//);
  const index = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  assert.match(index, /text: \(ids, agentId\) => inboxWakeTextForProvider\(agentId \? hive\.registry\(\)\.agents\[agentId\]\?\.provider : undefined, \[\.\.\.ids\], agentId \? wakeMailMode\(agentId\) : 'inject'\)/);
  assert.match(index, /function wakeMailMode\(agentId: string\): MailPromptMode \{[\s\S]*?return mailPromptMode\(mode, override\);/);
});

test('P7-P10: god, the first god prompt, closing time and the heartbeat say "delivered to you", never "drain your inbox"', () => {
  const hive = readSource('src/main/hive.ts');
  assert.match(hive, /handle the mail delivered to you and triage every other agent/);
  assert.doesNotMatch(hive, /drain your inbox/i);
  assert.match(readSource('src/renderer/src/hooks/useHive.ts'), /'1\. Read your memory\.md; pending mail is delivered in your context\.'/);
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
