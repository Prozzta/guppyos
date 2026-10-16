'use strict';
/**
 * MEMORY-SEARCH-TIMEOUT-DURING-INDEX-189, the reproduction (run through the claims-drill runner:
 * Electron as Node, the app's better-sqlite3 + sqlite-vec, a jailed home, a sandbox hive).
 *
 * The REAL main-side client (NativeMemoryClient) here, and the REAL worker (runWorker) in its own
 * process (worker-host.cjs), joined by the IPC channel, as main and the utility process are. The
 * model is a fake ONNX session that takes STEP_MS per run (off the JS thread, as ONNX Runtime):
 * a loaded machine, where the rest of an index step plus a search's own query embed is usually
 * more than the 250 ms warm budget. What matters is the
 * cost of one step, not the number of parts, so the claims sync is PARTS parts, not Jim's 1757.
 *   leg 'index': agent w1 is raised (its claims replace its markdown); a claims sync runs while
 *                one search at a time (wing w2, plain markdown) is sent, every 50 ms.
 *   leg 'hang':  the model stops answering; a claims sync starts; 3 searches time out.
 *   leg 'queue': the worker's own wiring of fix C (Jim S1). A step is held; three searches are
 *                sent to the worker directly (its protocol, not the client) behind it; the middle
 *                one's deadline passes while it waits. Its reply and the host's run count say
 *                whether the worker passed the deadline on, and whether ok replies carry timing.
 * Invented text only.
 */
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');

const STEP_MS = 200;
const PARTS = 40;
/** Raw protocol ids for leg 'queue', far above the client's own. */
const RAW_ID = 9_000;
const HOLD_MS = 600;

function write(root, rel, text) {
  const p = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

module.exports = async (drill) => {
  drill.assert.harnessStarted();
  drill.assert.homeJailed();
  const L = (rel) => drill.loadTs(rel);
  const { NativeMemoryClient } = L('src/main/nativeMemory/service.ts');
  const { withParts } = L('src/main/claims/chunks.ts');
  const { sha256Hex } = L('src/main/claims/canonical.ts');
  const leg = drill.args.leg;
  const hive = drill.hive;
  write(hive, 'agents/w1/memory.md', '# Memory\n\n## 2026-10-01\n- the quartz pallet sits in aisle four\n');
  write(hive, 'agents/w2/memory.md', '# Memory\n\n## 2026-10-01\n- the zeppelin hangar code is twelve\n');
  write(hive, 'agents/w1/memory/claims/2026-10.jsonl', '');
  write(hive, 'agents/w1/memory/claims-import.json', '{"v":1}\n');
  write(hive, 'memory-sources.json', JSON.stringify({ topLevel: [], include: {}, ledger: { w1: 'reader' } }));

  // A minimal BERT WordPiece tokenizer (the tree's model may be absent: needModel false).
  const modelDir = path.join(drill.home, 'stub-model');
  write(modelDir, 'tokenizer.json', JSON.stringify({
    normalizer: { type: 'BertNormalizer', lowercase: true, strip_accents: null, handle_chinese_chars: true, clean_text: true },
    pre_tokenizer: { type: 'BertPreTokenizer' },
    model: { type: 'WordPiece', unk_token: '[UNK]', continuing_subword_prefix: '##', max_input_chars_per_word: 100, vocab: { '[PAD]': 0, '[UNK]': 1, '[CLS]': 2, '[SEP]': 3 } },
  }));
  const cfg = { hiveRoot: hive, dbFile: path.join(drill.home, 'db', 'worker.sqlite'), modelDir, modelSha256: null, vecPath: drill.vecPath, vecSha256: drill.vecSha256, claimLedger: 'reader' };

  // The worker process: this drill's own child, killed at the end.
  const child = fork(path.join(__dirname, 'worker-host.cjs'), [], { execPath: process.execPath, env: process.env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced' });
  const handle = {
    postMessage: (m) => { if (m && m.op !== 'init') child.send(m); },
    on: (ev, fn) => { child.on(ev, fn); },
    kill: () => child.kill(),
  };
  const rows = [];
  const events = [];
  /** Leg 'queue': the worker's own replies to raw protocol requests (ids from RAW_ID up). */
  const raw = new Map();
  let fatal = null;
  let hostRuns = null;
  child.on('message', (m) => {
    if (m && m.event === 'indexing') events.push(`${m.on ? 'on' : 'off'}:${m.kind}`);
    if (m && m.event === 'fatal') fatal = m.error;
    if (m && typeof m.hostRuns === 'number') hostRuns = m.hostRuns;
    if (m && typeof m.id === 'number' && m.id >= RAW_ID) raw.set(m.id, m);
  });
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const client = new NativeMemoryClient({ fork: () => handle, config: () => cfg, log: (r) => rows.push(r) });
    client.prewarm();
    child.send({ host: 'start', tree: drill.tree, cfg, stepMs: STEP_MS });
    const runsNow = async () => { hostRuns = null; child.send({ host: 'runs' }); for (let i = 0; i < 100 && hostRuns === null; i++) await pause(10); return hostRuns; };

    const search = async (deadlineMs) => {
      const t0 = Date.now();
      const r = await client.request('search', { query: 'zeppelin hangar code', wing: 'w2', results: 3, caller: 'w2', mode: 'live' }, deadlineMs);
      return { exit: r.exit, ms: Date.now() - t0, hits: Array.isArray(r.json) ? r.json.length : 0, error: r.error ?? null };
    };
    // The startup backfill (joined) and one first search that loads the model: the client is
    // warm from here. The backfill's ok reply already marks the client warm, so this setup search
    // would get the quiet 250 ms budget; give it an explicit one (the suite's load once took 262 ms).
    const bf = await client.request('backfill', {}, 60_000);
    const cold = await search(30_000);
    if (fatal) return { ok: false, reason: 'the worker failed', error: fatal };
    const chunks = withParts(Array.from({ length: PARTS }, (_, i) => {
      const content = `fact · - · 2026-10-16\nclaim ${i}: the quartz pallet sits in aisle four, row ${i}`;
      return { claimId: `c-${String(i).padStart(12, '0')}`, wing: 'w1', kind: 'fact', ckey: null, at: '2026-10-16T07:00:00.000Z', status: 'live', content, contentSha256: sha256Hex(content) };
    }));
    const syncArgs = { wing: 'w1', path: 'agents/w1/memory/claims', head: 'h1', chunks, claimLedger: 'reader' };

    if (leg === 'index') {
      const runsBefore = await runsNow();
      let done = false;
      const sync = client.request('claims-sync', syncArgs, 120_000).then((r) => { done = true; return r; });
      const during = [];
      while (!done) { during.push(await search()); await pause(50); }
      const synced = await sync;
      const after = await search();
      const stepRuns = (await runsNow()) - runsBefore;
      return { ok: true, bf: bf.exit, cold, synced: { ok: synced.ok, json: synced.json, error: synced.error ?? null }, during, after, rows, events, stepRuns };
    }
    if (leg === 'hang') {
      child.send({ host: 'hang' });
      void client.request('claims-sync', syncArgs, 120_000);
      const timedOut = [];
      for (let i = 0; i < 3; i++) { timedOut.push(await search()); await pause(150); }
      return { ok: true, bf: bf.exit, cold, timedOut, rows, events };
    }
    if (leg === 'queue') {
      const args = { query: 'zeppelin hangar code', wing: 'w2', results: 3, caller: 'w2', mode: 'live' };
      const runsBefore = await runsNow();
      child.send({ host: 'hold' });
      const t0 = Date.now();
      const send = (id, deadline) => handle.postMessage({ id, op: 'search', args, deadline });
      send(RAW_ID + 1, t0 + 30_000);
      await pause(50);
      send(RAW_ID + 2, t0 + HOLD_MS / 2);
      send(RAW_ID + 3, t0 + 30_000);
      await pause(HOLD_MS);
      child.send({ host: 'release' });
      for (let i = 0; i < 1_000 && raw.size < 3; i++) await pause(10);
      const stepRuns = (await runsNow()) - runsBefore;
      const strip = (m) => (m ? { ok: m.ok, exit: m.exit, error: m.error ?? null, hits: Array.isArray(m.json) ? m.json.length : 0, timing: m.timing ?? null } : null);
      return { ok: true, bf: bf.exit, cold, held: strip(raw.get(RAW_ID + 1)), expired: strip(raw.get(RAW_ID + 2)), after: strip(raw.get(RAW_ID + 3)), stepRuns, holdMs: HOLD_MS };
    }
    return { ok: false, reason: `unknown leg ${leg}` };
  } finally {
    child.kill();
  }
};
