'use strict';
/**
 * MEMORY-SEARCH-TIMEOUT-DURING-INDEX-189: the memory worker in its OWN process, as in the app (a
 * utility process): forked by scenario.cjs with the drill's jailed env (Electron as Node). It runs
 * the tree's real runWorker over this process's IPC channel, with a fake ONNX session that takes
 * stepMs per run (a loaded machine) or, after {host:'hang'}, never answers; after {host:'hold'}
 * each run waits for {host:'release'}.
 * Host-control messages carry `host`; everything else is the worker protocol.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const DIM = 384;
let hang = false;
/** After {host:'hold'}, every step waits until {host:'release'}. */
let hold = null;
let runs = 0;
let started = false;
const listeners = [];

process.on('message', (m) => {
  if (m && m.host === 'start' && !started) { started = true; void start(m); return; }
  if (m && m.host === 'hang') { hang = true; return; }
  if (m && m.host === 'hold') { let release; hold = new Promise((r) => { release = r; }); hold.release = release; return; }
  if (m && m.host === 'release') { const h = hold; hold = null; if (h) h.release(); return; }
  if (m && m.host === 'runs') { process.send({ hostRuns: runs }); return; }
  for (const fn of listeners) fn({ data: m });
});

async function start({ tree, cfg, stepMs }) {
  try {
    const loadTs = require(path.join(tree, 'test', 'load-ts.cjs'));
    const treeRequire = createRequire(path.join(tree, 'package.json'));
    const { runWorker } = loadTs(path.join(tree, 'src', 'main', 'nativeMemory', 'worker.ts'));
    const ort = {
      Tensor: class { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } },
      InferenceSession: {
        create: async () => ({
          inputNames: ['input_ids', 'attention_mask', 'token_type_ids'],
          run: async (feeds) => {
            runs++;
            if (hang) return new Promise(() => {});
            if (hold) await hold;
            // ONNX Runtime runs the graph off the JS thread (session.run is async): the step
            // takes stepMs, the worker's event loop stays free to take messages meanwhile.
            await new Promise((r) => setTimeout(r, stepMs));
            const [n, len] = feeds.input_ids.dims;
            return { last_hidden_state: { data: new Float32Array(n * len * DIM).fill(1), dims: [n, len, DIM] } };
          },
        }),
      },
    };
    const port = { on: (_ev, fn) => listeners.push(fn), postMessage: (m) => process.send(m) };
    fs.mkdirSync(path.dirname(cfg.dbFile), { recursive: true });
    await runWorker(cfg, port, { Database: treeRequire('better-sqlite3'), ort });
  } catch (err) {
    process.send({ event: 'fatal', error: String((err && err.stack) || err) });
  }
}
