'use strict';

/**
 * Mutant runner for CLAIMS-90 M1 (compact, current-first memory search / wake-up output under the
 * condenser cap) and M3a (the `<key>: <current value>` lead line; rows `m3a-*`). Each mutant injects ONE
 * named regression into ONE source file, runs the M1 + M3a test files, and must turn them RED. An anchor that is missing or not unique is INERT and counts as a
 * failure of the run. Same engine as gtc-m4-mutants.cjs. HEAVY: run it in the heavy slot.
 *
 *   node test/tools/claims90-m1-mutants.cjs [name-prefix]
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recover, mutateFile, restoreFile } = require('./mutant-runner-helper.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
recover(ROOT);
// The shared helper journals src/ only. resources/memory-cli.cjs is mutated here directly, with the
// original bytes kept in the OS temp dir until the restore; a run killed mid-mutant is repaired on the next start.
const CLI_BACKUP = path.join(os.tmpdir(), 'claims90-m1-mutants-memory-cli.orig');
const inSrc = (file) => file.startsWith(`src${path.sep}`) || file.startsWith('src/');
function mutateAny(file, abs, original, mutated) {
  if (inSrc(file)) return mutateFile(ROOT, abs, original, mutated);
  fs.writeFileSync(CLI_BACKUP, original);
  fs.writeFileSync(abs, mutated);
}
function restoreAny(file, abs, original) {
  if (inSrc(file)) return restoreFile(ROOT, abs, original);
  fs.writeFileSync(abs, original);
  fs.rmSync(CLI_BACKUP, { force: true });
}
if (fs.existsSync(CLI_BACKUP)) {
  fs.writeFileSync(path.join(ROOT, 'resources/memory-cli.cjs'), fs.readFileSync(CLI_BACKUP));
  fs.rmSync(CLI_BACKUP, { force: true });
  console.log('recovered resources/memory-cli.cjs from an interrupted run');
}
if (process.argv.includes('--recover-only')) process.exit(0);
const TESTS = ['test/claims90-m1-compact.test.cjs', 'test/native-memory.test.cjs', 'test/claims90-m3a-lead.test.cjs', 'test/claims90-m3-rank.test.cjs',
  // CLAIMS-90 R2 (C90-GET): the lookup, the search modes and the cross-path test.
  'test/claims90-get.test.cjs', 'test/claims90-search-modes.test.cjs', 'test/claims90-get-paths.test.cjs', 'test/hook-broker-p3.test.cjs'];
const GET = 'src/main/claims/get.ts';
const HOOKS = 'src/main/hooks.ts';
const FORMAT = 'src/main/nativeMemory/format.ts';
const WIRING = 'src/main/nativeMemory/mainWiring.ts';
const SERVICE = 'src/main/nativeMemory/service.ts';
const ENGINE = 'src/main/nativeMemory/engine.ts';
const CLI = 'resources/memory-cli.cjs';
const INDEX = 'src/main/index.ts';
const VIEWS = 'src/main/claims/views.ts';

const MUTANTS = [
  ['a the compact budget is over the condenser cap', FORMAT, 'export const COMPACT_MAX_CHARS = 1400;', 'export const COMPACT_MAX_CHARS = 1600;'],
  ['b the wake-up share leaves no room for the claims working set', FORMAT, 'export const WAKE_COMPACT_MAX_CHARS = 700;', 'export const WAKE_COMPACT_MAX_CHARS = 1400;'],
  ['c priors come first', FORMAT, "h.claim.status === 'live' ? 0 : 2", "h.claim.status === 'live' ? 2 : 0"],
  ['d the default is the verbose text', FORMAT, 'return flags.full ? formatSearchFull(query, flags, hits) : formatSearchCompact(query, flags, hits);', 'return formatSearchFull(query, flags, hits);'],
  ['e an unconfirmed supersession is shown as a certain prior', FORMAT, "status === 'superseded?' ? 'prior?' : status", "status === 'superseded?' ? 'prior' : status"],
  ['f a wrapped content line is not held to the line max', FORMAT, 'const CONTENT_WIDTH = COMPACT_LINE_MAX - 4;', 'const CONTENT_WIDTH = COMPACT_LINE_MAX + 40;'],
  ['g a hit that no longer fits is printed anyway', FORMAT, 'if (budget < COMPACT_MIN_HIT) { out.push(footer(left)); break; }', 'if (false) { out.push(footer(left)); break; }'],
  ['h the search budget is not charged per hit', FORMAT, 'used += costOf(meta, lines);', 'used += 0;'],
  ['i a wake-up entry that no longer fits is printed anyway', FORMAT, 'if (used + budget + 1 + reserve > WAKE_COMPACT_MAX_CHARS) { out.push(more(left)); break; }', 'if (false) { out.push(more(left)); break; }'],
  ['j the wake-up default is the verbose frame', FORMAT, 'return opts.full ? formatWakeUpFull(identity, entries, pinned) : formatWakeUpCompact(identity, entries, pinned);', 'return formatWakeUpFull(identity, entries, pinned);'],
  ['k fitLines never cuts', FORMAT, 'if (block.length <= max) return block;', 'return block;'],
  ['l fitLines drops the pointer', FORMAT, 'if (used + more(left).length <= max) out.push(more(left)); break;', 'break;'],
  ['m the compact wake-up puts the claims working set last', WIRING, 'else if (claims) text = [fitLines(claims, Math.max(0, COMPACT_MAX_CHARS - String(text ?? \'\').length - 2)), text].filter(Boolean).join(\'\\n\\n\');', 'else if (claims) text = [text, fitLines(claims, Math.max(0, COMPACT_MAX_CHARS - String(text ?? \'\').length - 2))].filter(Boolean).join(\'\\n\\n\');'],
  ['n the compact wake-up does not fit the claims block', WIRING, 'text = [fitLines(claims, Math.max(0, COMPACT_MAX_CHARS - String(text ?? \'\').length - 2)), text]', 'text = [claims, text]'],
  ['o --full on wake-up is ignored by the wiring', WIRING, "const full = !('exit' in v) && v.args.full === true;", 'const full = false;'],
  ['p the request validation drops full on search', SERVICE, 'caller: callerWing, mode, kind, key, full: a.full === true, exact:', 'caller: callerWing, mode, kind, key, full: false, exact:'],
  ['q the request validation drops full on wake-up', SERVICE, "return { op: 'wake-up', args: { wing: wing ?? callerWing, full: a.full === true } };", "return { op: 'wake-up', args: { wing: wing ?? callerWing, full: false } };"],
  ['r the engine ignores full on wake-up', ENGINE, 'return { exit: 0, text: formatWakeUp(identity, entries, pinned, { full }) };', 'return { exit: 0, text: formatWakeUp(identity, entries, pinned) };'],
  ['s the CLI does not parse --full', CLI, "if (flag === '--full' && (out.cmd === 'search' || out.cmd === 'wake-up')) { out.args.full = true; i += 1; continue; }", ''],
  ['t the CLI parses --full on every command', CLI, "if (flag === '--full' && (out.cmd === 'search' || out.cmd === 'wake-up')) { out.args.full = true; i += 1; continue; }", "if (flag === '--full') { out.args.full = true; i += 1; continue; }"],
  ['u a clipped chunk shows its head, not a window around the matched term', FORMAT, "if (at < 0 || (mode === 'auto' && at + 24 <= max - 1)) return { text: clip(s, max), clipped: true };", 'if (true) return { text: clip(s, max), clipped: true };'],
  ['v the clipped hits are not counted in the footer', FORMAT, 'if (clipped) out.push(clipNote(clipped));', ''],
  // — CLAIMS-90 R2 (C90-GET) —
  ['w get: a newer card mail naming a known value never becomes current', GET, '          if (!named.length) continue;', '          continue;'],
  ['x get: any newer card mail becomes current (unknown value)', GET, '          if (!named.length) continue;', '          if (!named.length) named = [\'\'];'],
  ['y get: times compare without the claim pick (every mail is newer)', GET, '        const pickMs = pick ? atMs(pick) : -Infinity;', '        const pickMs = -Infinity;'],
  ['z get: a dashed mail-id time drops its milliseconds (tie / mixed formats)', GET, "return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5] ?? '000'}Z`) : NaN;", "return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.000Z`) : NaN;"],
  ['A get: --agent ignores the derived row naming the agent\'s done mail', GET, "      ?? values.find((c) => c.agent === 'derived' && c.text.includes(`from ${agent} `))\n", ''],
  ['B get: the decision list is newest-only', GET, "const decisions = live.filter((c) => isDecision(canonicalKey(c.key ?? '', d.registry))).sort(newestFirst).map(row);", "const decisions = live.filter((c) => isDecision(canonicalKey(c.key ?? '', d.registry))).sort(newestFirst).slice(0, 1).map(row);"],
  ['C get: superseded rows carry no excerpt', GET, 'status: ix.status.get(c.id) ?? \'unknown\', excerpt: excerpt(c.text),', 'status: ix.status.get(c.id) ?? \'unknown\', excerpt: \'\','],
  ['D get: a card key does not cover its derived sub-keys', GET, "  for (const k of [...keySet]) if (isCardKey(k)) for (const other of ix.byKey.keys()) if (other.startsWith(`${k}.`)) keySet.add(other);\n", ''],
  ['E get: the done-sha rule is off (a sha in the agent\'s done mail is not a known value)', GET, "          if (!named.length && shaField && m.act === 'done' && (!agent || m.from === agent)) named = sha7(text);\n", ''],
  ['F get: the unknown-term line differs by path (keys tried not printed)', GET, 'L.push(`no claim under ${r.tried.join(\', \')}`);', 'L.push(`no claim under ${r.term}`);'],
  ['G search: the meta line carries no get pointer', FORMAT, "${h.claim.key ? ` · ${getPointer(h.claim.key)}` : ''}", ''],
  ['H newest: no gate (an old high-score row that matches nothing can lead)', FORMAT, 'const gated = (h: T): boolean => hasTerm(h.content, query) || h.bm25 !== null;', 'const gated = (h: T): boolean => true;'],
  ['I newest: a passing mention is not demoted', FORMAT, "return matched.length && matched.every((t) => passingOnly(h.content, t)) ? 1 : 0;", 'return 0;'],
  ['J newest: priors share the group of current claims', FORMAT, "const group = (h: T): number => (h.claim && h.claim.status !== 'live' ? 1 : 0);", 'const group = (h: T): number => 0;'],
  ['K exact: PROTOCOL.md and board.md are not read', ENGINE, "export const EXACT_TEXT_FILES = ['PROTOCOL.md', 'board.md'] as const;", 'export const EXACT_TEXT_FILES = [] as const;'],
  ['L exact: the needle keeps its quotes', ENGINE, "  const m = /^([\"'`])(.*)\\1$/.exec(s);\n  if (m) s = m[2].trim();\n", ''],
  ['M validation drops exact/newest', SERVICE, 'exact: a.exact === true, newest: a.newest === true', 'exact: false, newest: false'],
  ['N CLI does not parse --exact/--newest', CLI, "if (flag === '--exact' || flag === '--newest') { out.args[flag.slice(2)] = true; i += 1; continue; }", ''],
  ['O CLI does not parse the get flags', CLI, "if (flag === '--agent') { out.args.agent = val(); i += step(); continue; }", ''],
  ['P MCP memory_get passes only the term', HOOKS, "[MEMORY_GET_TOOL]: ['term', 'agent', 'mail', 'before', 'noMail', 'history'],", "[MEMORY_GET_TOOL]: ['term'],"],
  ['Q MCP memory_search drops exact/newest', HOOKS, "'kind', 'key', 'full', 'exact', 'newest']", "'kind', 'key', 'full']"],
  ['R M3 SHOULD 1: a 7+ hex word without a digit is a sha', FORMAT, '(/^[0-9a-f]{7,}$/.test(t) && /\\d/.test(t))', '/^[0-9a-f]{7,}$/.test(t)'],
  ['S M3 SHOULD 2: a dotted card id does not match card.<id>.* by prefix', FORMAT, "key === `card.${t}` || key.startsWith(`card.${t}.`)", 'false'],
  ['w a hit gets one even share, never more (the old per-hit split)', FORMAT, 'const COMPACT_SHARES = 3;', 'const COMPACT_SHARES = 1;'],
  ['x the UI search (hive:searchMemory) gets the compact text', INDEX, "nativeMemory.query('search', { query, full: true,", "nativeMemory.query('search', { query,"],
  ['y the UI wake-up (hive:memoryWakeUp) gets the compact text', INDEX, "nativeMemory.query('wake-up', { full: true,", "nativeMemory.query('wake-up', {"],
  ['z the head is kept even when the wrap cost popped the matched term (no window fallback)', FORMAT, "if (!w.text.startsWith('…') && hasTerm(text, query) && !hasTerm(ls.join(' '), query)) ls = fit(windowContent(text, query, mx, 'window').text, bud);", ''],
  // CLAIMS-90 M3a: the lead line.
  ['m3a-1 a prior or prior? hit gets a `key: value` lead as if it were current', FORMAT, "if (!h.claim || h.claim.status !== 'live') return null;", 'if (!h.claim) return null;'],
  ['m3a-2 a `##` heading becomes the value', FORMAT, ".filter((l) => !l.trim().startsWith('## '))", ''],
  ['m3a-3 the body repeats the lead instead of continuing after it', FORMAT, 'lines = split.rest ? [split.lead, ...window(split.rest, restMax, budget - leadCost)] : [split.lead];', 'lines = split.rest ? [split.lead, ...window(whole, restMax, budget - leadCost)] : [split.lead];'],
  ['m3a-4 a whole claim that fits keeps its header line instead of the key prefix', FORMAT, 'const whole = split ? (split.rest ? `${split.lead} ${split.rest}` : split.lead) : oneLine(h.content);', 'const whole = oneLine(h.content);'],
  ['m3a-5 a matched term cut in two by the shortened lead is lost (no plain-window fallback)', FORMAT, 'lines = hasTerm(whole, query) && !hasTerm(lead, query) && !hasTerm(from, query)', 'lines = false'],
  ['m3a-6 the lead is dropped on a tight share instead of shortened', FORMAT, '} else if (split && avail - 5 - 29 >= 24) {', '} else if (false) {'],
  ['m3a-7 the wake-up working set drops the key prefix', VIEWS, "claim.key ? claimLine({ ...claim, text: `${claim.key}: ${claim.text}` }, 'current', flags) : claimLine(claim, 'current', flags);", "claimLine(claim, 'current', flags);"],
  // CLAIMS-90 M3 (ranking): the specificity anchor and the key-aware lift.
  ['m3-1 the window anchors on the earliest term again (S2 back)', FORMAT, 'if (at < 0 || sp > best || (sp === best && i < at)) { at = i; best = sp; }', 'if (at < 0 || i < at) { at = i; best = sp; }'],
  ['m3-2 the compact order is currentFirst only (no lift)', FORMAT, 'const ordered = flags.newest ? newestOrder(query, hits) : rankHits(query, hits);', 'const ordered = flags.newest ? newestOrder(query, hits) : currentFirst(hits);'],
  ['m3-3 a plain word that is a key segment lifts', FORMAT, "if (key && (key === t || (sp === 3 && (key.split('.').includes(t) || key === `card.${t}` || key.startsWith(`card.${t}.`))))) return true;", "if (key && (key === t || key.split('.').includes(t) || key === `card.${t}` || key.startsWith(`card.${t}.`))) return true;"],
  ['m3-4 a sha / version / card id in the content does not lift', FORMAT, 'return sp === 3 && h.content.toLowerCase().includes(t);', 'return false;'],
  ['m3-5 a named prior crosses above the live value', FORMAT, '.sort((a, b) => a.g - b.g || a.n - b.n || a.i - b.i)', '.sort((a, b) => a.n - b.n || a.g - b.g || a.i - b.i)'],
  ['m3-6 a version is not a naming term', FORMAT, " || /^\\d+\\.\\d+(\\.\\d+)+$/.test(t)", ''],
  // CLAIMS-90 R2 (god db7d4a, fe1140): weak mention-body links, T2 hidden bodies, T3 dropped stale search hits, T5 link-strength tiebreak.
  ['T db7d4a: a body-only mention can make a mail current', GET, "{ field: 8, reply: 4, conversation: 2, 'mention-subject': 1 };", "{ field: 8, reply: 4, conversation: 2, 'mention-subject': 1, 'mention-body': 1 };"],
  ['U T2: the text view always lists the competing/superseded bodies', GET, 'const bodies = opts.history === true || !hideStale();', 'const bodies = true;'],
  ['V T3: a live search keeps confirmed priors', ENGINE, "return hits.filter((h) => !h.claim || h.claim.status !== 'superseded').slice(0, k);", 'return hits.slice(0, k);'],
  ['W T5: equal-time mails have no link-strength tiebreak', GET, '.sort((a, b) => b.ms - a.ms || linkRank(b.m.cardFrom) - linkRank(a.m.cardFrom));', '.sort((a, b) => b.ms - a.ms);'],
];

const prefix = process.argv[2] || '';
const selected = MUTANTS.filter(([name]) => name.startsWith(prefix));
let killed = 0; let inert = 0;
for (const [name, file, from, to] of selected) {
  const abs = path.join(ROOT, file);
  const original = fs.readFileSync(abs, 'utf8');
  const crlf = original.includes('\r\n');
  const lf = original.replace(/\r\n/g, '\n');
  const at = lf.indexOf(from);
  if (at < 0 || lf.indexOf(from, at + 1) >= 0) {
    inert++;
    console.log(`INERT     ${name}  (anchor ${at < 0 ? 'missing' : 'not unique'} in ${file})`);
    continue;
  }
  let mutated = lf.slice(0, at) + to + lf.slice(at + from.length);
  if (crlf) mutated = mutated.replace(/\n/g, '\r\n');
  try {
    mutateAny(file, abs, original, mutated);
    const r = spawnSync(process.execPath, ['--test', ...TESTS], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
    const fails = (String(r.stdout).match(/^# fail (\d+)/m) || [])[1] ?? '?';
    const dead = r.status !== 0;
    if (dead) killed++;
    console.log(`${dead ? 'KILLED  ' : 'SURVIVED'}  ${name}  (failing tests: ${fails})`);
  } finally {
    restoreAny(file, abs, original);
  }
}
console.log(`\n${killed}/${selected.length} killed${inert ? `, ${inert} INERT` : ''}`);
process.exit(killed === selected.length ? 0 : 1);
