'use strict';
/*
 * CLAIMS-90 R2 (C90-GET): this build's `memory get` over a HIVE FOLDER, offline (the auditor's lookup replay over
 * the jailed T_s copy). No app, no HTTP, no token: the raw claim ledgers under agents/<id>/memory/claims/*.jsonl,
 * memory-keys.json, claims-reconcile-queue.json, tasks.json and state/mail-cards/<card>.jsonl are read as files,
 * and resolveGet + formatGet run exactly as main runs them behind the endpoint. READ-ONLY: nothing is written.
 *
 *   node test/tools/claims90-get.cjs <hiveRoot> <term> [--agent A] [--mail N] [--before MAILID] [--no-mail] [--all] [--json]
 *
 * Output: the get text on stdout (`--json`: the GetResult JSON, the same object the CLI prints with --format json).
 * Exit 0 (also for an unknown term: "no claim under <keys tried>" on the text path, current null on JSON), 2 usage,
 * 1 error. Plain node: nothing here needs the Electron ABI.
 */
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--agent', '--mail', '--before'].includes(argv[i - 1])));
const [hiveRoot, term] = positional;
if (!hiveRoot || !term) { process.stderr.write('usage: claims90-get.cjs <hiveRoot> <term> [--agent A] [--mail N] [--before MAILID] [--no-mail] [--all] [--json]\n'); process.exit(2); }

/** Raw ledger lines of every agent with a claims folder (the auditor's copy has no MAC key: every parseable row counts). */
function readLedgers(root) {
  const out = {};
  const agents = path.join(root, 'agents');
  let ids = [];
  try { ids = fs.readdirSync(agents); } catch { return out; }
  for (const id of ids) {
    const dir = path.join(agents, id, 'memory', 'claims');
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort(); } catch { continue; }
    const recs = [];
    for (const f of files) {
      for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { const v = JSON.parse(line); if (v && typeof v.id === 'string' && (v.t === 'claim' || v.t === 'event')) recs.push(v); } catch { /* a torn or foreign line */ }
      }
    }
    if (recs.length) out[id] = recs;
  }
  return out;
}

try {
  const loadTs = require(path.join(REPO, 'test', 'load-ts.cjs'));
  const { resolveGet, formatGet } = loadTs('src/main/claims/get.ts');
  const { DEFAULT_KEY_REGISTRY, loadRegistry } = loadTs('src/main/claims/registry.ts');
  const ledgers = readLedgers(hiveRoot);
  let registry; try { registry = loadRegistry(hiveRoot); } catch { registry = DEFAULT_KEY_REGISTRY; }
  let reconcileItems = [];
  try {
    const q = JSON.parse(fs.readFileSync(path.join(hiveRoot, 'claims-reconcile-queue.json'), 'utf8'));
    for (const a of Object.values(q.agents ?? {})) reconcileItems.push(...(a.items ?? []));
  } catch { /* no queue */ }
  let tasks = [];
  try { const t = JSON.parse(fs.readFileSync(path.join(hiveRoot, 'tasks.json'), 'utf8')); tasks = Array.isArray(t) ? t : (t.tasks ?? []); } catch { /* no tasks */ }
  const mailRows = (card) => {
    if (!/^[a-z0-9][a-z0-9._-]{0,119}$/.test(card)) return null;
    try { return fs.readFileSync(path.join(hiveRoot, 'state', 'mail-cards', `${card}.jsonl`), 'utf8').split('\n'); } catch { return null; }
  };
  const agent = val('--agent');
  const mail = val('--mail') === null ? undefined : Number(val('--mail'));
  const opts = { agent, mail, before: val('--before'), noMail: has('--no-mail'), history: has('--all') || has('--history') };
  const r = resolveGet(term, opts, { ledgers, registry, reconcileItems, tasks, mailRows, ruleConfig: { r4: false } });
  process.stdout.write(has('--json') ? JSON.stringify(r) + '\n' : formatGet(r, { agent, history: opts.history }));
} catch (e) {
  process.stderr.write(`claims90-get: ${e && e.stack ? e.stack : String(e)}\n`);
  process.exitCode = 1;
}
