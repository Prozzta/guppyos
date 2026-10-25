'use strict';
/**
 * CLAIMS-90 R2 (C90-GET, god ae1569 + 8218c8, Jim df789a b-d): the search side of the lookup.
 *  - every keyed claim hit carries `get: memory get <key>` on its meta line (HISTORY-PTR g) and a `Get:` line in --full;
 *  - `--newest`: among hits the compact gate lets through (a query term in the text, or a lexical match) the order is
 *    newest first with [1] the answer candidate; a hit that only mentions a specific term in PASSING (replaced X,
 *    was X, X -> , from X to, X replaced by) comes after the hits that state it; prior claims stay last; ungated hits
 *    keep rank order after; the header names the mode; the JSON keeps its array shape with both ranks;
 *  - `--exact`: a substring scan whose needle drops quotes and folds whitespace; PROTOCOL.md and board.md are read as
 *    text lines (`<file>:<line>`, wing hive, room docs); a wing/room/kind/key filter leaves the files out;
 *  - the request validation and the CLI parse the two flags; the usage text names them and `get`;
 *  - M3 SHOULDs 1-3 (Jim's audit): a sha needs a digit, a card id is a hyphenated token with a digit segment, a dotted
 *    card id matches `card.<id>.*` by prefix.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const REPO = path.resolve(__dirname, '..');
const F = loadTs('src/main/nativeMemory/format.ts');
const E = loadTs('src/main/nativeMemory/engine.ts');
const P = loadTs('src/main/claims/historyPointer.ts');
const { validateRequest } = loadTs('src/main/nativeMemory/service.ts');

const hit = (i, content, claim, extra = {}) => ({ chunkId: i, wing: 'a1', room: 'memory', source: 'agents/a1/claims.jsonl', content, cosineSim: 0.4, bm25: 0.9, score: 0.9 - i / 1000, claim, ...extra });
const meta = (id, key, at, status = 'live', kind = 'fact') => ({ id, status, kind, key, at });
const md = (i, content, filedAt) => hit(i, content, null, { source: `agents/a1/memory-${i}.md`, filedAt });
const lines = (t) => t.replace(/\n$/, '').split('\n');
const order = (q, hits) => F.newestOrder(q, hits).map((h) => (h.claim ? h.claim.id : h.source));

test('passingOnly: the shapes that name an OLD value are passing; a text that states the term anywhere else is not (Jim d: "replaced X with Y in commit Z" states Y and Z)', () => {
  const yes = [['we replaced 1111111 with 2222222 in commit 3333333', '1111111'], ['build was 1.1.100, now 1.1.102', '1.1.100'], ['from 1.1.100 to 1.1.102', '1.1.100'], ['1.1.100 -> 1.1.102', '1.1.100'], ['1.1.100 → 1.1.102', '1.1.100'], ['1.1.100 was replaced by 1.1.102', '1.1.100'], ['tip "1111111" replaced with 2222222', '1111111'], ['previously 1111111; later 2222222', '1111111']];
  for (const [c, t] of yes) assert.equal(F.passingOnly(c, t), true, `${c} / ${t}`);
  const no = [['we replaced 1111111 with 2222222 in commit 3333333', '2222222'], ['we replaced 1111111 with 2222222 in commit 3333333', '3333333'], ['the tip is 1.1.100 (previously 1.1.099)', '1.1.100'], ['previously 1.1.100; the tip is 1.1.100 again', '1.1.100'], ['1.1.100 shipped', '1.1.100'], ['nothing here', '1.1.100'], ['the password was reset at 1.1.100', '1.1.100']];
  for (const [c, t] of no) assert.equal(F.passingOnly(c, t), false, `${c} / ${t}`);
});

test('newestOrder: gated hits newest first; a passing-only mention follows the hits that state the term; prior claims last; ungated hits trail in rank order (MUTANTS: no gate, no demotion)', () => {
  const hits = [
    hit(0, 'old note: build at 1111111', meta('c1', 'k', '2026-10-01T00:00:00Z')),
    hit(1, 'we replaced 1111111 with 2222222', meta('c2', 'k', '2026-10-05T00:00:00Z')),
    hit(2, 'nothing relevant but a high score', null, { bm25: null, source: 'agents/a1/memory-x.md', filedAt: Date.parse('2026-12-01T00:00:00Z') }),
    md(3, 'note: 1111111 is still what runs', Date.parse('2026-10-03T00:00:00Z')),
    hit(4, 'prior: 1111111 forever', meta('c5', 'k', '2026-10-09T00:00:00Z', 'superseded')),
    hit(5, 'build at 1111111 confirmed', meta('c6', 'k', '2026-10-04T00:00:00Z')),
  ];
  assert.deepEqual(order('1111111', hits), ['c6', 'agents/a1/memory-3.md', 'c1', 'c2', 'c5', 'agents/a1/memory-x.md'],
    'stating hits newest first (c6 10-04, md 10-03, c1 10-01), then the passing mention (c2, though newest), then the prior, then the ungated');
  // Without a specific term nothing is demoted: pure newest first among live + markdown, priors last.
  assert.deepEqual(order('build', hits.slice(0, 2).concat(hits[5])), ['c2', 'c6', 'c1']);
  // Ties keep rank order.
  const tie = [hit(0, 'x 1111111', meta('t1', 'k', '2026-10-01T00:00:00Z')), hit(1, 'y 1111111', meta('t2', 'k', '2026-10-01T00:00:00Z'))];
  assert.deepEqual(order('1111111', tie), ['t1', 't2']);
  // A hit with no time at all sorts last in its group (hitTimeMs 0).
  assert.equal(F.hitTimeMs({ claim: null }), 0);
  assert.equal(F.hitTimeMs({ claim: meta('z', 'k', '2026-10-01T00:00:00Z') }), Date.parse('2026-10-01T00:00:00Z'));
  assert.equal(F.hitTimeMs({ claim: null, filedAt: 5 }), 5);
});

test('compact output: every keyed claim hit ends its meta line with `· get: memory get <key>`; --newest names its order and [1] is the newest stating hit; --exact names the scan', () => {
  const hits = [hit(0, 'k.a: build at 1111111 old', meta('c1', 'k.a', '2026-10-01T00:00:00Z')), hit(1, 'k.a: build at 1111111 new', meta('c2', 'k.a', '2026-10-05T00:00:00Z')), md(2, 'a note without a key', 1)];
  const plain = F.formatSearchCompact('1111111', {}, hits);
  assert.match(plain, /^\[1\] current · fact · k\.a · 2026-10-01 · c1 · a1\/memory · get: memory get k\.a$/m, 'MUTANT: no pointer');
  assert.match(plain, /^Results for: "1111111" — 3 hits, current first \(--full: whole chunks\)$/m);
  const newest = F.formatSearchCompact('1111111', { newest: true }, hits);
  assert.match(newest, /^Results for: "1111111" — 3 hits, newest first \(\[1\] answer candidate\) \(--full: whole chunks\)$/m);
  assert.match(newest, /^\[1\] current · fact · k\.a · 2026-10-05 · c2 /m, '[1] is the newest stating hit');
  const exact = F.formatSearchCompact('1111111', { exact: true, newest: true }, hits);
  assert.match(exact, /newest first \(\[1\] answer candidate\), exact text/);
  const mdOnly = lines(plain).find((l) => l.startsWith('[3] '));
  assert.ok(mdOnly && !mdOnly.includes('get: memory get'), 'a markdown hit has no key, so no pointer');
  for (const l of lines(newest)) assert.ok(l.length <= F.COMPACT_LINE_MAX, `line within the max: ${l.length}`);
});

test('full output: a keyed claim hit carries a `Get:    memory get <key>` line after Claim; --newest reorders the full listing too', () => {
  const hits = [hit(0, 'k.a: build at 1111111 old', meta('c1', 'k.a', '2026-10-01T00:00:00Z')), hit(1, 'k.a: build at 1111111 new', meta('c2', 'k.a', '2026-10-05T00:00:00Z'))];
  const full = F.formatSearchFull('1111111', {}, hits);
  assert.match(full, /^      Get:    memory get k\.a$/m);
  const ls = lines(full);
  const claimLine = ls.findIndex((l) => /^      Claim:/.test(l));
  assert.ok(claimLine >= 0 && /Get:    memory get k\.a/.test(ls[claimLine + 1]), 'Get follows Claim');
  const newest = F.formatSearchFull('1111111', { newest: true }, hits);
  assert.ok(newest.indexOf('c2') < newest.indexOf('c1'), 'newest first in --full');
});

test('--exact: the needle drops surrounding quotes and folds whitespace; PROTOCOL.md and board.md lines are hits `<file>:<line>` (wing hive, room docs, at most k per file); a missing file is no hit', () => {
  assert.equal(E.exactNeedle('  "Hello   World" '), 'hello world');
  assert.equal(E.exactNeedle("'No INT, no publish'"), 'no int, no publish');
  assert.equal(E.exactNeedle('plain  text'), 'plain text');
  // god 6f7b2c: markup-insensitive on every source. MUTANT: needle keeps ** / backticks, or a file line is compared raw.
  assert.equal(E.exactNeedle('**No INT**, no `publish`'), 'no int, no publish');
  assert.equal(E.stripMarkup('a **b** `c`'), 'a b c');
  assert.deepEqual([...E.EXACT_TEXT_FILES], ['PROTOCOL.md', 'board.md'], 'god 8218c8: the D5 rows');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c90-exact-'));
  fs.writeFileSync(path.join(root, 'PROTOCOL.md'), '# P\n\nThe heavy slot: one job.\nNo INT, no publish.\nA third Heavy Slot line.\n');
  fs.writeFileSync(path.join(root, 'board.md'), 'board\r\n- rule: **No INT**, no `publish` (god)\r\n');
  const hits = E.exactFileHits(root, 'no int, no publish', 5);
  assert.deepEqual(hits.map((h) => [h.source, h.wing, h.room, h.content]), [['PROTOCOL.md:4', 'hive', 'docs', 'No INT, no publish.'], ['board.md:2', 'hive', 'docs', '- rule: **No INT**, no `publish` (god)']]);
  assert.ok(hits.every((h) => h.claim === null && h.bm25 === null && typeof h.filedAt === 'number'));
  assert.equal(E.exactFileHits(root, 'heavy slot', 1).length, 1, 'k caps per file');
  // Creed efae3e: --exact hits are served through the history-pointer rewrite too (matched on the raw line first).
  fs.appendFileSync(path.join(root, 'PROTOCOL.md'), 'ptr memory.md#claim-history-c-a1 line\n');
  const raw = E.exactFileHits(root, 'memory.md#claim-history-c-a1', 5);
  assert.equal(raw.length, 1, 'the raw anchor text matches');
  const served = E.servedHits(raw);
  assert.equal(served[0].content, P.withHistoryCommands(raw[0].content)); assert.notEqual(served[0].content, raw[0].content, 'MUTANT: exact hits not rewritten');
  assert.equal(served[0].source, 'PROTOCOL.md:6');
  assert.equal(E.exactFileHits(root, 'heavy slot', 5).length, 2, 'case-folded');
  fs.rmSync(path.join(root, 'board.md'));
  assert.equal(E.exactFileHits(root, 'no int', 5).length, 1, 'a missing file is skipped');
  assert.equal(E.exactFileHits(path.join(root, 'nope'), 'x', 5).length, 0);
  // Under --newest a file line is gated by the term it holds (bm25 is null), so it takes part.
  const fileHit = { ...hits[0], chunkId: -1, cosineSim: null, score: 0 };
  assert.deepEqual(order('no int, no publish', [hit(0, 'unrelated chunk', meta('c1', 'k', '2026-10-01T00:00:00Z'), { bm25: null }), fileHit]), ['PROTOCOL.md:4', 'c1']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('request validation and CLI: exact/newest are booleans on search (a non-boolean is refused); the CLI parses --exact/--newest and the get flags; USAGE names get, --exact and --newest', () => {
  const v = validateRequest({ cmd: 'search', args: { query: 'q', exact: true, newest: true } }, 'w');
  assert.equal(v.args.exact, true); assert.equal(v.args.newest, true);
  const v0 = validateRequest({ cmd: 'search', args: { query: 'q' } }, 'w');
  assert.equal(v0.args.exact, false); assert.equal(v0.args.newest, false);
  assert.ok('exit' in validateRequest({ cmd: 'search', args: { query: 'q', exact: 'yes' } }, 'w'), 'MUTANT: a string exact passes');
  assert.ok('exit' in validateRequest({ cmd: 'search', args: { query: 'q', newest: 1 } }, 'w'));
  const CLI = path.join(REPO, 'resources', 'memory-cli.cjs');
  const cp = require('node:child_process'); const real = cp.spawnSync; cp.spawnSync = () => ({});
  delete require.cache[require.resolve(CLI)];
  let cli; try { cli = require(CLI); } finally { cp.spawnSync = real; }
  assert.deepEqual(cli.parseArgs(['search', 'No INT', '--exact', '--newest', '--results', '3']).args, { exact: true, newest: true, results: 3, query: 'No INT' });
  const g = cli.parseArgs(['get', 'FOO-7', '--agent', 'alpha-1', '--mail', '2', '--before', '2026-10-25T07-14-05-563Z-df789a', '--no-mail', '--format', 'json']);
  assert.equal(g.cmd, 'get'); assert.equal(g.format, 'json');
  assert.deepEqual(g.args, { agent: 'alpha-1', mail: 2, before: '2026-10-25T07-14-05-563Z-df789a', noMail: true, term: 'FOO-7' });
  assert.deepEqual(cli.parseArgs(['get', 'card.foo-7.donesha']).args, { term: 'card.foo-7.donesha' });
  assert.deepEqual(cli.parseArgs(['wake-up', '--exact']).rest, ['--exact'], 'not a wake-up option');
  const USAGE = fs.readFileSync(CLI, 'utf8');
  assert.match(USAGE, /usage: memory \{get KEY\|CARD-ID \[--agent A\] \[--mail N\] \[--before MAILID\] \[--no-mail\] \[--all\] \| search QUERY [^\n]*\[--exact\] \[--newest\] \[--full\] \| wake-up/);
});

test('help text on every path names `memory get` and `--exact` (hive.ts briefing + protocol line + FLOOR COMMANDS + PROTOCOL.md section; the capabilities skill)', () => {
  const hive = fs.readFileSync(path.join(REPO, 'src', 'main', 'hive.ts'), 'utf8');
  assert.ok((hive.match(/\\?`memory get <key\|card-id>\\?`/g) || []).length >= 6, 'briefing lines (writer + non-writer), protocol line one (both), FLOOR COMMANDS, PROTOCOL section');
  assert.match(hive, /- `memory get <key\|card-id>` — the CURRENT value of a key or card as a field/);
  assert.match(hive, /`--exact` scans text \(quoted lines, PROTOCOL\.md, board\.md, changelog entries\); `--newest` orders newest first/);
  assert.match(hive, /- \\`memory get <key\|card-id>\\` — the CURRENT value of a key or card, as a field: the\r?\n  newest live claim/);
  assert.match(hive, /\\`--exact\\` for an exact line \(quoted rulings,\r?\n  PROTOCOL\.md, board\.md, changelog entries\); \\`--newest\\` for newest first/);
  const skill = fs.readFileSync(path.join(REPO, 'resources', 'skills', 'capabilities', 'SKILL.md'), 'utf8');
  assert.match(skill, /`memory search "<query>"` to recall shared knowledge, `memory get <key\|card-id>`\r?\n  for the current value of a key or card/);
});

test('M3 SHOULDs 1-3 (Jim\'s audit): a sha needs a digit; a card id is a hyphenated token with a digit segment (claims-90, cl-m4-forward-path-2, cut-1.1.100 via card.); a dotted card id matches card.<id>.* by prefix', () => {
  for (const t of ['f00dcafe', 'deadbee1', '1.1.102', 'claims-90', 'gate-178', 'cl-m4-forward-path-2', 'c-0000000000a3']) assert.equal(F.termSpecificity(t), 3, t);
  for (const t of ['deadbeef', 'abcdefabcdef', 'release.tip', 'card.claims-90', '1.1']) assert.notEqual(F.termSpecificity(t), 3, `${t} is not a sha or card id`);
  assert.equal(F.termSpecificity('deadbeef'), 1, 'SHOULD 1: seven+ hex letters without a digit is a word');
  for (const t of ['release', 'claims-', 'c-abc', 'x-1y-', 'foo-bar', 'one-two-three']) assert.equal(F.termSpecificity(t), 1, t);
  // SHOULD 2: a dotted card id names its keys by prefix (card.cut-1.1.100.status), so the key-aware lift applies.
  assert.equal(F.termSpecificity('cut-1.1.100'), 3, 'a dotted card id is a level-3 term (census row S needs this to bite)');
  assert.equal(F.termSpecificity('cut-1.1'), 3); assert.equal(F.termSpecificity('cut-1.1.'), 1);
  const hits = [hit(0, 'status doing', meta('d1', 'card.cut-1.1.100.status', '2026-10-01T00:00:00Z')), hit(1, 'cut-1.1.100 mentioned in a note about release 1.1.100', meta('d2', 'release.1.1.100', '2026-10-02T00:00:00Z'))];
  const ranked = F.rankHits('cut-1.1.100', hits);
  assert.equal(ranked[0].claim.id, 'd1', 'the card\'s own key is lifted over a mention');
});

test('T3 (god fe1140): a live-mode search drops confirmed-superseded claim hits (prior) unless --history/--all or C90_HIDE_STALE=0; prior? and markdown stay; k caps after the drop; both engine branches and the search oracle drop', () => {
  const hits = [hit(1, 'a', meta('c1', 'k.a', '2026-10-01T00:00:00Z', 'superseded')), hit(2, 'b', meta('c2', 'k.a', '2026-10-02T00:00:00Z')),
    hit(3, 'c', meta('c3', 'k.b', '2026-10-02T00:00:00Z', 'superseded?')), md(4, 'd', '2026-10-01T00:00:00Z'), hit(5, 'e', meta('c5', 'k.c', '2026-10-03T00:00:00Z'))];
  const ids = (xs) => xs.map((h) => h.chunkId);
  assert.deepEqual(ids(E.dropStale(hits, 'live', 5, {})), [2, 3, 4, 5], 'MUTANT: priors kept in live mode');
  assert.deepEqual(ids(E.dropStale(hits, undefined, 5, {})), [2, 3, 4, 5]);
  assert.deepEqual(ids(E.dropStale(hits, 'history', 5, {})), [1, 2, 3, 4, 5]);
  assert.deepEqual(ids(E.dropStale(hits, 'all', 5, {})), [1, 2, 3, 4, 5]);
  assert.deepEqual(ids(E.dropStale(hits, 'live', 5, { C90_HIDE_STALE: '0' })), [1, 2, 3, 4, 5], 'the OFF arm');
  assert.deepEqual(ids(E.dropStale(hits, 'live', 2, {})), [2, 3], 'k caps after the drop');
  assert.equal(E.staleFetchK(5, 'live', {}), 10); assert.equal(E.staleFetchK(5, 'history', {}), 5); assert.equal(E.staleFetchK(5, 'live', { C90_HIDE_STALE: '0' }), 5); assert.equal(E.staleFetchK(80, 'live', {}), 100);
  const fs = require('node:fs');
  const eng = fs.readFileSync(path.join(REPO, 'src/main/nativeMemory/engine.ts'), 'utf8');
  assert.equal((eng.match(/dropStale[<(]/g) || []).length, 3, 'the definition, the exact branch and the vector branch');
  const oracle = fs.readFileSync(path.join(REPO, 'test/tools/claims90-search.cjs'), 'utf8');
  assert.equal((oracle.match(/dropStale\(/g) || []).length, 2, 'the search oracle drops on both branches too');
  assert.equal((oracle.match(/staleFetchK\(/g) || []).length, 2, 'both store calls fetch 2k');
});
