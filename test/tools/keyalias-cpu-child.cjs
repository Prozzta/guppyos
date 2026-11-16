'use strict';

// STARTUP-FREEZE-104: measure the production-shaped cold first census in a fresh process. The
// parent takes the minimum of three independent samples so a loaded worker cannot set the bar;
// a cold-path regression has to be fast in no child to evade it.
const path = require('node:path');
const loadTs = require('../load-ts.cjs');
const { cpuMsOf } = require('./thread-cpu.cjs');
const { keyAliasCandidates } = loadTs(path.join(__dirname, '../../src/main/claims/reconcile.ts'));

const REG = { v: 1, keys: {}, namespaces: [
  { pattern: 'card.*', cardinality: 'single' }, { pattern: 'release.*', cardinality: 'single' },
  { pattern: 'agent.<id>.*', cardinality: 'single' }, { pattern: 'agent.*', cardinality: 'single' },
  { pattern: 'project', cardinality: 'single' },
] };

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
function census(seed, n, words) {
  const r = rng(seed), pick = (a) => a[Math.floor(r() * a.length)];
  const stems = ['startup-freeze', 'int', 'cut', 'mail_rig', 'blob-meeting', 'node-lts', 'e45-int', 'gate', 'heavy-lock', 'claims-export', 'own-procs-task-kill-pin', 'own_procs_task_kill_pin', 'ownprocstaskkillpin'];
  const base = [];
  for (let i = 0; i < words; i++) {
    const ns = pick(['card.', 'release.', 'agent.owner.', 'agent.other.', 'project.', 'misc.']);
    let stem = pick(stems);
    const v = r();
    if (v < 0.25) stem += `-1.1.${100 + Math.floor(r() * 8)}`;
    else if (v < 0.35) stem += `-${Math.floor(r() * 30)}`;
    else if (v < 0.5) stem = stem.replace('-', '_');
    else if (v < 0.6) stem = stem.slice(0, -1);
    else if (v < 0.7) stem = stem + pick(['x', 's', 'ed']);
    else stem += `.${pick(['a', 'b', 'note', 'status'])}`;
    base.push(ns + stem);
  }
  const records = [], claims = {};
  for (let i = 0; i < n; i++) {
    const id = `c-${(Math.floor(r() * 1e9)).toString(16)}-${i}`;
    const agent = r() < 0.9 ? 'owner' : 'other';
    const key = r() < 0.08 ? undefined : pick(base);
    records.push({ id, t: 'claim', agent, key, kind: 'fact', text: 'x' });
    claims[id] = { status: r() < 0.8 ? 'live' : pick(['superseded', 'retracted']) };
  }
  return { records, state: { claims } };
}

const { records, state } = census(11, 17000, 3000);
let found;
const cpu = cpuMsOf(() => { found = keyAliasCandidates('owner', records, state, REG); });
process.stdout.write(`${JSON.stringify({ cpu, found: found.length })}\n`);
