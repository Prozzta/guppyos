'use strict';
/**
 * CLAIM-LEDGER W2 wall-clock gates, in the SERIAL PERF LANE (test/tools/run-tests.cjs runs every
 * test/perf/*.perf.cjs with --test-concurrency=1, after the parallel suite).
 *
 * Why a lane of their own: under the full parallel suite these two timings measured the machine, not
 * derive() (203 ms and 279 ms in 2 of 3 full runs, 3/3 green alone). The bounds are FROZEN gates
 * (only the Human may change them): 200 ms each, a single measurement, exactly as in the parallel
 * suite before. Their correctness halves (claim count, hot-key status) stay in
 * test/claims-derive-w2.test.cjs.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..', '..');
function loadTs(relative) {
  const filename = path.resolve(ROOT, relative);
  const source = fs.readFileSync(filename, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const loaded = { exports: {} };
  const localRequire = (specifier) => {
    if (!specifier.startsWith('.')) return require(specifier);
    const target = path.resolve(path.dirname(filename), specifier);
    const tsTarget = path.extname(target) ? target : `${target}.ts`;
    if (tsTarget.endsWith('.ts') && fs.existsSync(tsTarget)) {
      return loadTs(path.relative(ROOT, tsTarget));
    }
    return require(target);
  };
  new Function('exports', 'require', 'module', js)(loaded.exports, localRequire, loaded);
  return loaded.exports;
}

const { derive } = loadTs('src/main/claims/derive.ts');
const registry = {
  v: 1,
  namespaces: [{ pattern: 'fact.*', cardinality: 'single' }, { pattern: 'multi.*', cardinality: 'multi' }],
  keys: { 'fact.alias': { cardinality: 'single', addedAt: '2026-01-01T00:00:00.000Z', addedBy: 'human', aliasOf: 'fact.name' }, 'fact.name': { cardinality: 'single', addedAt: '2026-01-01T00:00:00.000Z', addedBy: 'human' } },
};
function claim(id, { key, source = 'self', text = id, at = '2026-01-01T00:00:00.000Z', wt = at, mac = `mac-${id}`, prev = '', ...extra } = {}) {
  return { v: 1, id, t: 'claim', kind: 'fact', ...(key ? { key } : {}), text, source, at, wt, agent: 'agent-a', mac, prev, ...extra };
}

test('G2.6 10k distinct claims derive under 200ms', () => {
  const rows = Array.from({ length: 10_000 }, (_, index) => claim(`c${String(index).padStart(5, '0')}`, { key: `fact.k${index}`, mac: `m${index}` }));
  const start = process.hrtime.bigint();
  const state = derive(rows, registry, { r4: false });
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(Object.keys(state.claims).length, 10_000);
  assert.ok(elapsedMs < 200, `derive took ${elapsedMs.toFixed(1)}ms`);
});

test('R2 remains bounded for a hot single key at the 10k-claim scale', () => {
  const rows = Array.from({ length: 10_000 }, (_, index) => claim(`h${String(index).padStart(5, '0')}`, {
    key: 'fact.hot', at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(), mac: `mh${index}`,
  }));
  const start = process.hrtime.bigint();
  const state = derive(rows, registry, { r4: false });
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(state.claims.h09999.status, 'live');
  assert.ok(elapsedMs < 200, `single-key derive took ${elapsedMs.toFixed(1)}ms`);
});
