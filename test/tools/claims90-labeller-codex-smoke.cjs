'use strict';
/**
 * CLAIMS-90 T6 smoke: one REAL codex session through labeller-codex.cjs on a synthetic jail (two made-up rows, no H1,
 * key or snapshot file), so the real exe, login handling, sandbox and event audit are proven before a real T6 batch.
 * Prints the verdict fields only; no event text, no credential. Leaves nothing behind.
 *
 *   node test/tools/claims90-labeller-codex-smoke.cjs [--codex <exe>] [--codex-auth <auth.json>]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const L = require('../claims-90/labeller.cjs');
const CX = require('../claims-90/labeller-codex.cjs');

(async () => {
  const argv = process.argv.slice(2);
  const opt = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
  const out = fs.mkdtempSync(path.join(path.resolve(__dirname, '..', '..', '..'), 'c90-codex-smoke-'));
  const jail = fs.mkdtempSync(path.join(out, 'jail-smoke-t6-'));
  const scratch = fs.mkdtempSync(path.join(out, 'scratch-smoke-t6-'));
  const runDir = path.join(out, 'run'); fs.mkdirSync(runDir);
  fs.mkdirSync(path.join(jail, 'docs'));
  fs.writeFileSync(path.join(jail, 'docs', 'batch-01.jsonl'), '{"itemId":"syn-1","question":"Which colour is named in docs/facts.md?"}\n{"itemId":"syn-2","question":"Which number is named in docs/facts.md?"}\n');
  fs.writeFileSync(path.join(jail, 'docs', 'facts.md'), '# Facts\nThe colour is teal.\nThe number is 42.\n');
  const keyFile = path.join(jail, 'key.jsonl');
  const openLog = path.join(runDir, 'open-log.jsonl'); fs.writeFileSync(openLog, '');
  const prompt = `Answer each row in docs/batch-01.jsonl using only files inside ${jail.replace(/\\/g, '/')}. For each row write one JSON object with itemId, value, source and quote.${CX.CODEX_NOTE.replace('{keyFile}', keyFile.replace(/\\/g, '/'))}`;
  const own = [{ itemId: 'syn-1' }, { itemId: 'syn-2' }];
  let s;
  try {
    s = await CX.codexSession({ exe: opt('--codex') || CX.codexExe(), model: null, jail, scratch, runDir, keyFile, openLog, jailFiles: L.jailFiles, prompt, baseEnv: L.jailEnv(jail, scratch), authFile: opt('--codex-auth') || CX.realAuthFile(), timeoutMs: 15 * 60_000 });
    const key = L.checkKey(fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8') : '', own);
    const reason = CX.codexReason(s, key, own);
    const values = key.rows.map((r) => `${r.itemId}=${r.value}`).join(' ');
    console.log(JSON.stringify({ verdict: reason ? 'INVALID' : 'VALID', reason, exit: s.exit, calls: s.audit?.calls.length ?? 0, outside: s.audit?.outside ?? 0, otherItems: s.audit?.otherItems ?? null, authAtCommand: s.authAtCommand, authRefreshed: s.authRefreshed, authWrittenBack: s.authWrittenBack, credentialHits: s.credentialHits, homeRemoved: s.homeRemoved, authAbsentAfter: s.authAbsentAfter, leftovers: s.leftovers.length, jailChanged: s.jailChanged, keyed: key.keyed, values, tokens: CX.codexTokens(s.audit?.usage) }));
    process.exitCode = reason ? 1 : 0;
  } finally {
    fs.rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    console.log(`smoke folder removed: ${!fs.existsSync(out)}`);
  }
})().catch((e) => { console.error(String(e.message || e).slice(0, 300)); process.exitCode = 2; });
