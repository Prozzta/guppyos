'use strict';

// CLAIMS-WARM-BACKFILL-106: the hand-mutant census of the codes memo (deriveOffMain.ts), the fallback snapshot rule
// (indexSync.ts) and the wiring (index.ts). Each mutant damages ONE unique anchor and must make
// test/claims-warm-backfill-106.test.cjs fail AT ITS OWN NAMED TEST; a survivor, a kill elsewhere or a missing anchor
// fails the census. A heavy job: run it in a heavy slot.
//   node test/tools/claims-warm-backfill-106-mutants.cjs
// Every mutant goes through mutant-runner-helper.cjs (journal, then restore in a finally).
const fs = require('node:fs');
const path = require('node:path');
const { recover, mutateFile, restoreFile, checkAnchors } = require('./mutant-runner-helper.cjs');
const { runTests, verdict, requireBaseline } = require('./mutant-tap.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST = 'test/claims-warm-backfill-106.test.cjs';
const OFF = 'src/main/claims/deriveOffMain.ts';
const SYNC = 'src/main/claims/indexSync.ts';
const MAIN = 'src/main/index.ts';

const SAME = /not ok \d+ - 106: the same codes job/;
const CHANGED = /not ok \d+ - 106: a changed head, count, registry or r4 posts again/;
const DRAIN1 = /not ok \d+ - 106 drain: a failed worker's jobs settle one per turn/;
const DRAIN2 = /not ok \d+ - 106 drain: a job run during the drain/;
const DRAIN3 = /not ok \d+ - 106 drain: stop\(\) drains the same way/;
const MUTANTS = [
  ['W1 the memo is never used', OFF, 'if (last && last.head === memo.head', 'if (false && last.head === memo.head', SAME],
  ['W2 head not compared', OFF, 'last.head === memo.head && last.count', 'last.count', CHANGED],
  ['W3 count not compared', OFF, '&& last.count === memo.count && last.registry', '&& last.registry', CHANGED],
  ['W4 registry not compared', OFF, '&& last.registry === memo.registry && last.r4', '&& last.r4', CHANGED],
  ['W5 r4 not compared', OFF, ' && last.r4 === memo.r4) {', ') {', CHANGED],
  ['W6 one memo for every agent', OFF, 'const last = this.codes.get(job.agentId);', "const last = this.codes.get('a1');", CHANGED],
  ['W7 an unfrozen registry is kept', OFF, 'if (p.memo && Object.isFrozen(p.memo.registry)) this.codes.set', 'if (p.memo) this.codes.set', /not ok \d+ - 106: an unfrozen registry is never reused/],
  ['W8 chunks jobs are memoized', OFF, "const memo: CodesMemo | null = job.want === 'codes' ? {", 'const memo: CodesMemo | null = true ? {', /not ok \d+ - 106: chunks jobs and failed answers/],
  ['W9 stop keeps the memo', OFF, '    this.codes.clear();\n', '', /not ok \d+ - 106: chunks jobs and failed answers/],
  ['W10 a fallback keeps a snapshot with the worker on', SYNC, 'if (prefix.truncatedAt || workerOn) this.snapshots.delete', 'if (prefix.truncatedAt) this.snapshots.delete', /not ok \d+ - 106: after a fallback sync/],
  ['W11 absent offMainEnabled counts as off', SYNC, '(this.d.offMainEnabled?.() ?? true)', '(this.d.offMainEnabled?.() ?? false)', /not ok \d+ - 106: offMainEnabled absent/],
  ['W12 a disabled worker is ignored', SYNC, 'const workerOn = !!this.d.offMain && (this.d.offMainEnabled?.() ?? true);', 'const workerOn = !!this.d.offMain;', /not ok \d+ - 106: the worker off/],
  ['W13 no offMain counts as on', SYNC, 'const workerOn = !!this.d.offMain && (', 'const workerOn = true && (', /not ok \d+ - 106: the worker off/],
  ['W14 the worker inherits execArgv', MAIN, "join(__dirname, 'claimsDeriveWorker.js'), { execArgv: [] })", "join(__dirname, 'claimsDeriveWorker.js'))", /not ok \d+ - 106 wiring/],
  ['W15 main passes no offMainEnabled', MAIN, '      offMainEnabled: () => claimsDeriveOffMain.enabled,\n', '', /not ok \d+ - 106 wiring/],
  // The fallback drain (Jim's SHOULD on c9cf16c6, god go).
  ['W16 the drain settles every job in one turn', OFF, '        p.resolve(r);\n        this.yieldTurn(next);', '        p.resolve(r);\n        next();', DRAIN1],
  ['W17 the first job settles in the failing turn', OFF, '      };\n      this.yieldTurn(next);\n    });', '      };\n      next();\n    });', DRAIN1],
  ['W18 a run during the drain does not wait', OFF, '    if (this.drain) return this.drain.then(() => this.run(job));\n', '', DRAIN2],
  ['W19 the drain ends in the turn of the last settle', OFF, '        p.resolve(r);\n        this.yieldTurn(next);', '        p.resolve(r);\n        if (all.length) this.yieldTurn(next); else { this.drain = null; done(); }', DRAIN2],
  // Not a row: a drain that never clears makes run() re-chain on the settled drain forever in microtasks, which starves
  // every timer, so the file dies only at the runner's timeout, never at a named assert. DRAIN2's late-job post pins it.
  ['W20 a memo hit waits for the drain', OFF, "    const memo: CodesMemo | null = job.want === 'codes'", "    if (this.drain) return this.drain.then(() => this.run(job));\n    const memo: CodesMemo | null = job.want === 'codes'", DRAIN3],
  ['W21 stop settles at once', OFF, '    if (w) { try { w.terminate(); } catch { /* gone */ } }\n    this.settleAll(null);\n  }\n\n  private worker()', '    if (w) { try { w.terminate(); } catch { /* gone */ } }\n    for (const p of this.pending.values()) { this.clearTimer(p.timer); p.resolve(null); }\n    this.pending.clear();\n  }\n\n  private worker()', DRAIN3],
  ['W22 the default turn is synchronous', OFF, '((fn) => { setImmediate(fn); })', '((fn) => { fn(); })', /not ok \d+ - 106 drain wiring/],
];

const run = () => runTests(ROOT, [TEST], { timeout: 300_000 });
recover(ROOT);
if (process.argv.includes('--recover-only')) process.exit(0);
checkAnchors(ROOT, MUTANTS.map(([name, file, from]) => ({ name, file, from })));
if (process.argv.includes('--anchors-only')) { console.log('ANCHORS OK'); process.exit(0); }
requireBaseline(run(), TEST);

let bad = 0;
for (const [name, file, from, to, dies] of MUTANTS) {
  const abs = path.join(ROOT, file);
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
  const outcome = verdict(r, dies);
  const killed = outcome === 'KILLED';
  if (!killed) bad += 1;
  console.log(`${outcome} ${name}`);
}
console.log(bad ? `CENSUS FAILED: ${bad} of ${MUTANTS.length}` : `CENSUS OK: ${MUTANTS.length}/${MUTANTS.length} killed at their named test`);
process.exit(bad ? 1 : 0);
