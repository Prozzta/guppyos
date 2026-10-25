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
const TESTS = ['test/claims90-m1-compact.test.cjs', 'test/native-memory.test.cjs', 'test/claims90-m3a-lead.test.cjs'];
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
  ['p the request validation drops full on search', SERVICE, 'caller: callerWing, mode, kind, key, full: a.full === true } };', 'caller: callerWing, mode, kind, key, full: false } };'],
  ['q the request validation drops full on wake-up', SERVICE, "return { op: 'wake-up', args: { wing: wing ?? callerWing, full: a.full === true } };", "return { op: 'wake-up', args: { wing: wing ?? callerWing, full: false } };"],
  ['r the engine ignores full on wake-up', ENGINE, 'return { exit: 0, text: formatWakeUp(identity, entries, pinned, { full }) };', 'return { exit: 0, text: formatWakeUp(identity, entries, pinned) };'],
  ['s the CLI does not parse --full', CLI, "if (flag === '--full' && (out.cmd === 'search' || out.cmd === 'wake-up')) { out.args.full = true; i += 1; continue; }", ''],
  ['t the CLI parses --full on every command', CLI, "if (flag === '--full' && (out.cmd === 'search' || out.cmd === 'wake-up')) { out.args.full = true; i += 1; continue; }", "if (flag === '--full') { out.args.full = true; i += 1; continue; }"],
  ['u a clipped chunk shows its head, not a window around the matched term', FORMAT, "if (at < 0 || (mode === 'auto' && at + 24 <= max - 1)) return { text: clip(s, max), clipped: true };", 'if (true) return { text: clip(s, max), clipped: true };'],
  ['v the clipped hits are not counted in the footer', FORMAT, 'if (clipped) out.push(clipNote(clipped));', ''],
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
