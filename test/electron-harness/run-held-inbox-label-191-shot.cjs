'use strict';
/** HELD-INBOX-LABEL-191: write an AgentCard quiet-held-mail screenshot and fail if its label regresses. */
const { mkdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { runScenario } = require('./run.cjs');
const at = process.argv.indexOf('--out');
const out = at >= 0 ? resolve(process.argv[at + 1]) : null;
if (!out) { console.error('--out <dir> is required'); process.exit(2); }

(async () => {
  const result = await runScenario(join(__dirname, 'scenarios', 'held-inbox-label-191-shot.tsx'), { width: 480, height: 140, timeoutMs: 120_000 });
  const local = new Date(Date.UTC(2030, 0, 2, 6, 53)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (!result.ok || !result.layout || !result.untruncated || result.mail?.text !== `✉1 held ${local}` || result.mail?.title !== `inbox 1 (held until ${local} local); 1 message waiting; or sooner with other mail`) {
    console.error(JSON.stringify(result));
    process.exit(1);
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'held-inbox-label-191.png'), Buffer.from(result.png.slice(result.png.indexOf(',') + 1), 'base64'));
  writeFileSync(join(out, 'held-inbox-label-191.json'), JSON.stringify({ mail: result.mail }, null, 2));
  console.log(`${join(out, 'held-inbox-label-191.png')} — ${result.mail.title}`);
})().catch((error) => { console.error(error); process.exit(1); });
