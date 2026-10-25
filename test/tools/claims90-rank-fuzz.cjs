'use strict';
/**
 * CLAIMS-90 R2 step 2 (Jim 595cc6, god e91938): rank fuzz for the compact search text. Claim chunks shaped like the
 * ledger's (a `kind · key · date` header line, then the text), 1-12 all-live hits on ONE key, text length <= 250 and
 * <= 400. Per (length, n, rank) two visibilities over seeded trials:
 *   whole: the hit's text is shown whole (its block is not clipped and ends with the text's last word);
 *   term:  a probe word put at a random place in that hit's text (the query) is shown in its block.
 * The bar: every n <= 5 cell at or above the baseline (a6116736), strict, no rounding.
 *
 *   node test/tools/claims90-rank-fuzz.cjs [--base a6116736] [--seeds 7,20261026] [--trials 500]
 * loads format.ts at HEAD and at --base (git show) and prints each cell below the baseline; exit 1 if any.
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const loadTs = require('../load-ts.cjs');

const WORDS = ('the a of to and in is on for at by with from as was were be not no now new old run test pass fail fix bug card mail '
  + 'merge branch commit sha tag build cut release gate audit census mutant ledger claim key value memory search hit rank wing room '
  + 'heavy lock slot queue wake agent god jim andy uhera creed done answer request report push origin int guppy config registry '
  + 'tasks cache read write stat racy window lead meta footer pointer budget share floor clip note line wrap cap condenser').split(' ');
const KEYS = ['release.tip', 'card.claims-90.state', 'card.heavy-lock-live-file-192.merge', 'card.main-sync-log-ledger.donesha#creed-mukyiphw', 'branch.claims-90-r2'];

/** mulberry32: a small seeded generator, so a seed names one fixture set. */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
const hex = (r, n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(r() * 16)]).join('');

/** Ledger-like text of about `len` chars: words, now and then a sha, a version or a claim id. */
function text(r, len) {
  const out = [];
  let n = 0;
  while (n < len) {
    const x = r();
    const w = x < 0.05 ? hex(r, 8) : x < 0.08 ? `1.1.${100 + Math.floor(r() * 9)}` : x < 0.1 ? `c-${hex(r, 12)}` : pick(r, WORDS);
    out.push(w);
    n += w.length + 1;
  }
  return out.join(' ').slice(0, len).replace(/\s+\S*$/, '') || 'done';
}

const lines = (t) => t.replace(/\n$/, '').split('\n');
function block(t, n) {
  const ls = lines(t);
  const a = ls.findIndex((l) => l.startsWith(`[${n}] `));
  if (a < 0) return null;
  let b = a + 1;
  while (b < ls.length && ls[b].startsWith('    ')) b++;
  return ls.slice(a + 1, b).map((l) => l.slice(4)).join(' ');
}

/** cells[`${max}/${n}/${rank}`] = { whole, term } in percent over `trials` fixtures per (max, n). */
function fuzz(F, seed, trials = 500, maxes = [250, 400], ns = Array.from({ length: 12 }, (_, i) => i + 1)) {
  const cells = {};
  for (const max of maxes) for (const n of ns) {
    const r = rng(seed * 1000003 + max * 101 + n);
    const whole = new Array(n).fill(0);
    const term = new Array(n).fill(0);
    for (let t = 0; t < trials; t++) {
      const key = pick(r, KEYS);
      const kind = pick(r, ['fact', 'decision', 'lesson']);
      const texts = Array.from({ length: n }, () => text(r, 30 + Math.floor(r() * (max - 29))));
      const mk = (ts) => ts.map((x, i) => ({ chunkId: i + 1, wing: 'a1', room: 'memory', source: 'agents/a1/claims.jsonl', content: `${kind} · ${key} · 2026-10-0${1 + (i % 9)}\n${x}`,
        cosineSim: 0.5, bm25: -1, score: 1 - i / 1000, claim: { id: `c-${String(i).padStart(12, '0')}`, status: 'live', kind, key, at: `2026-10-0${1 + (i % 9)}T10:00:00.000Z` } }));
      // whole: a query that names nothing and matches nothing, so the order is the rank order.
      const tw = F.formatSearch('zzqx', {}, mk(texts));
      for (let i = 0; i < n; i++) {
        const b = block(tw, i + 1);
        const last = texts[i].split(' ').pop();
        if (b !== null && !b.includes('…') && b.endsWith(last)) whole[i]++;
      }
      // term: one probe (a 6-hex plain word: it names nothing, so no hit is lifted) at a random word boundary of each hit in turn.
      for (let i = 0; i < n; i++) {
        const probe = `${'abcdef'[i % 6]}${hex(r, 5)}`.replace(/^([0-9a-f]{6})$/, (m) => (/\d/.test(m) ? m.replace(/\d/g, 'e') : m));
        const ws = texts[i].split(' ');
        const at = Math.floor(r() * (ws.length + 1));
        const ti = texts.slice();
        ti[i] = [...ws.slice(0, at), probe, ...ws.slice(at)].join(' ');
        const b = block(F.formatSearch(probe, {}, mk(ti)), i + 1);
        if (b !== null && b.includes(probe)) term[i]++;
      }
    }
    for (let i = 0; i < n; i++) cells[`${max}/${n}/${i + 1}`] = { whole: (100 * whole[i]) / trials, term: (100 * term[i]) / trials };
  }
  return cells;
}

/** Cells (n <= nMax) where `head` is below `base`, strict. */
function below(head, base, nMax = 5) {
  const out = [];
  for (const [c, b] of Object.entries(base)) {
    if (Number(c.split('/')[1]) > nMax) continue;
    for (const m of ['whole', 'term']) if (head[c][m] < b[m]) out.push(`${c} ${m}: ${b[m]} -> ${head[c][m]}`);
  }
  return out;
}

module.exports = { fuzz, below, rng };

if (require.main === module) {
  const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
  const baseRev = arg('base', 'a6116736');
  const seeds = arg('seeds', '7,20261026').split(',').map(Number);
  const trials = Number(arg('trials', '500'));
  const root = path.resolve(__dirname, '..', '..');
  const rel = 'src/main/nativeMemory/format.ts';
  const headRev = arg('head', null);
  const H = headRev ? loadTs.fromText(rel, execFileSync('git', ['-C', root, 'show', `${headRev}:${rel}`], { encoding: 'utf8' })) : loadTs(rel);
  const B = loadTs.fromText(rel, execFileSync('git', ['-C', root, 'show', `${baseRev}:${rel}`], { encoding: 'utf8' }));
  let bad = 0;
  for (const seed of seeds) {
    const head = fuzz(H, seed, trials);
    const base = fuzz(B, seed, trials);
    const low = below(head, base);
    bad += low.length;
    console.log(`seed ${seed}: ${low.length} n<=5 cell(s) below ${baseRev}`);
    for (const l of low) console.log(`  ${l}`);
    if (process.argv.includes('--table')) console.log(JSON.stringify(Object.fromEntries(Object.entries(base).filter(([c]) => Number(c.split('/')[1]) <= 5))));
  }
  process.exit(bad ? 1 : 0);
}
