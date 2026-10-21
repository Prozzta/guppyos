/**
 * HEAVY-JOB-SERIALIZE (1.1.55; god andyheavy/andyheavycfg). On 2026-09-26 the Human's PC went
 * unresponsive with several CPU/antivirus-heavy jobs running at once from different agents (an
 * npm ci + electron-rebuild, a parity replay spawning a Python process per query, full test
 * suites, mutation runs). The floor rule "one heavy job at a time" was prose only, and it was
 * broken twice. This makes it a machine lock the app enforces at the PreToolUse boundary.
 *
 *  - classifyHeavy: a pure, table-driven classifier of a tool call's command (no model).
 *  - HeavyJobLock: a counting semaphore of `limit` slots (the Settings value "Heavy jobs at once":
 *    'off' or N, default 1), held per AGENT; released by the PostToolUse of a foreground call, by
 *    the job's processes exiting (a background job; checked only while held), by the holder's PTY
 *    exiting, or by a TTL.
 * No Electron dependency: every piece is injectable, so the tests never inspect the real machine.
 */
import { execFile } from 'node:child_process';

export type HeavyKind = 'install' | 'build' | 'suite' | 'bench';
/** `provisional`: HEAVY-LOCK-BG-LAPSE-189, heavy only because a script the command runs could not be
 *  read at PreToolUse (it does not exist yet, it is too big, its path is computed): the lock fails
 *  closed on it, and may let it go once the script reads as light (HeavyJobLock.settle). */
export interface HeavyClass { heavy: boolean; kind?: HeavyKind; why?: string; provisional?: boolean; exclusive?: boolean }

/**
 * HEAVY-SLOT-EXCLUSIVE-192: a whole suite (a FULL uses 21-24 of 32 logical CPUs) and a bench (load
 * benches start 48+ burners; the mutant runners; an opt-in bench gate) must not share the machine
 * with another heavy job when "Heavy jobs at once" is 2 or more: timing-sensitive tests ran
 * contaminated, twice. Such a call is EXCLUSIVE: the lock grants it only when every slot is free,
 * and starts nothing beside it while it holds. A class may also say so itself (`exclusive: true`);
 * the explicit marker for any command is an env gate before it (`GUPPY_HEAVY_EXCLUSIVE=1 <cmd>`,
 * BENCH_ENV). Installs and builds share. At one slot this changes nothing.
 * As for every BENCH_ENV gate (pre-existing behaviour): the marker counts only as a prefix of the
 * same command (`export X=1; npm run build` and `$env:X=1; ...` still share), and a gate word inside
 * a longer name counts too (`NON_EXCLUSIVE=1 node --test x` is a bench: it fails closed).
 */
export function heavyExclusive(cls: HeavyClass): boolean {
  return cls.heavy && (cls.exclusive === true || cls.kind === 'suite' || cls.kind === 'bench');
}

/** Command-shaped tool input (the same reading as DESKTOP-LAUNCH-GUARD's). `CommandLine`: AGY's
 *  run_command (HEAVY-CPU-OPTIONS-191: it was not read, so AGY heavy calls were never classified). */
export function commandFromToolInput(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const r = input as Record<string, unknown>;
  const v = r.command ?? r.cmd ?? r.script ?? r.CommandLine;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return (v as string[]).join(' ');
  return typeof v === 'string' ? v : null;
}

/**
 * HEAVY-JOB-LOCK-FAILOPEN (Andy 42b671): the index just past the `)` that closes the command
 * substitution `$(` at `i` (nested, quote-aware), or the end. A substitution is ONE opaque piece of
 * a word: `PATH="$(echo "$PATH" | tr : '\n' | grep -v x)" node test/tools/run-tests.cjs` used to be
 * split on the pipes inside it, and the suite after it was never seen (a full suite ran unlocked).
 */
function substEnd(s: string, i: number): number {
  let depth = 0;
  let q: string | null = null;
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (q === "'") { if (c === "'") q = null; continue; }
    if (c === '\\') { j += 1; continue; }
    if (q === '"') {
      if (c === '"') q = null;
      else if (c === '$' && s[j + 1] === '(') { j = substEnd(s, j) - 1; }
      continue;
    }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '(') depth += 1;
    else if (c === ')' && --depth === 0) return j + 1;
  }
  return s.length;
}

/**
 * HEAVY-LOCK-APOSTROPHE-SWALLOW: the quoting rules a command text is read with.
 *  - 'sh' (bash, and PowerShell, which agree here): `'` and `"` open quotes, mid-word too. That is
 *    the shells' real rule, measured: `echo don't; node …` is a PARSE ERROR in both (nothing runs),
 *    and `echo don't; node …; echo it's` runs only the echo (the middle is one quoted string).
 *  - 'cmd' (the body of `cmd /c`): only `"` quotes; `'` is an ordinary character, so
 *    `cmd /c "echo don't & npm test"` RUNS npm test; `^` escapes; `;` separates nothing; no `#`.
 */
export type ShellDialect = 'sh' | 'cmd';

/**
 * Does the quote character at `i` OPEN a quote (outside quotes)? Not when the dialect has no such
 * quote (`'` in cmd), and not when it is escaped by an odd run of the escape character before it:
 * `\'` (bash), `` `' `` (PowerShell), `^"` (cmd). Escaped, the shell runs what follows; read as an
 * opener, the scanner swallowed it (`echo don\'t; node test/tools/run-tests.cjs` was light).
 */
function opensQuote(s: string, i: number, d: ShellDialect): boolean {
  const c = s[i];
  if (c !== '"' && (c !== "'" || d === 'cmd')) return false;
  const esc = d === 'cmd' ? ['^'] : ['\\', '`'];
  let n = 0;
  while (i - n - 1 >= 0 && esc.includes(s[i - n - 1]) && s[i - n - 1] === s[i - 1]) n++;
  return n % 2 === 0;
}

/**
 * A-S2: does the `"` at `i` CLOSE sh's double quote? Only an ODD run of backslashes before it
 * escapes it: `"a\\"` is the string a\ and closed (measured: bash prints a\ and runs what follows).
 */
function closesDouble(s: string, i: number): boolean {
  let n = 0;
  while (i - n - 1 >= 0 && s[i - n - 1] === '\\') n++;
  return n % 2 === 0;
}

/**
 * Split a command line into words, honouring simple quotes (not a full shell parser). Quotes
 * concatenate with attached redirection operators (`2>"path with spaces"`); a quote opens only
 * where the dialect's opensQuote says so (`'` is literal in cmd). A `$(...)` is opaque.
 */
function words(s: string, d: ShellDialect = 'sh'): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) { i++; continue; }
    let w = '';
    let q: string | null = null;
    while (i < s.length) {
      const c = s[i];
      if (!q && /\s/.test(c)) break;
      // Unquoted shell redirections terminate the current word even without surrounding spaces:
      // `node "suite.cjs">full.log` has a script argument then a redirect, not one path.
      const redirectAt = /^(?:\d*(?:>>?|<<?-?|<>)|&>>?|\*>>?)/;
      if (!q && w && redirectAt.test(s.slice(i)) && !redirectAt.test(w + s.slice(i))) break;
      // A-S1: a backslash escapes nothing inside sh's '...'. In a cmd body the WORDS are the
      // program's argv, split by the C runtime after cmd removed its carets (measured: `"p\" q`
      // is one argument, `a^"b c"` is `ab c`, `x^ y` is two): `\"` escapes and every `"` opens.
      // HEAVY-LOCK-SHAPES-189 (Jim NIT 1): inside sh's "...", `\"` `\\` `\$` and `` \` `` lose the
      // backslash, as bash removes it; kept, a `bash -c "bash -c '... \"...\"'"` body split on a `\"`.
      if (c === '\\' && q === '"' && d === 'sh' && /["\\$`]/.test(s[i + 1] ?? '')) { w += s[i + 1]; i += 2; continue; }
      if (c === '\\' && q !== "'" && i + 1 < s.length) { w += c + s[i + 1]; i += 2; continue; }
      if (!q && (d === 'cmd' ? c === '"' : opensQuote(s, i, d))) { q = c; i++; continue; }
      if (q && c === q) { q = null; i++; continue; }
      if (d === 'sh' && c === '$' && s[i + 1] === '(' && q !== "'") { const e = substEnd(s, i); w += s.slice(i, e); i = e; continue; }
      w += c;
      i++;
    }
    if (q) w = `__HEAVY_UNCLOSED_QUOTE__${w}`;
    out.push(w);
  }
  return out;
}

/** HEAVY-LOCK-POSITIONAL-192: an sh option word that includes `c` (`-c`, `-lc`, `-ec`); `-C` is noclobber. */
const SH_DASH_C = /^-[A-Za-z]*c[A-Za-z]*$/;
/** A single-quoted sh `-c` body is expanded by its inner shell, not the outer one. */
function singleQuotedDashCBody(segment: string | undefined, option: string): boolean {
  // HEAVY-LOCK-POSITIONAL-192: `-lc`, `-ec` ... are -c with other flags (SH_DASH_C).
  if (!segment || !SH_DASH_C.test(option)) return false;
  // This must describe the wrapper at this recursion depth, rather than an inner
  // `bash -c '...'` merely mentioned inside its double-quoted body.
  return /^(?:\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*)?(?:(?:\S+[/\\])?(?:bash|sh|dash|zsh)|busybox\s+sh)(?:\s+(?:-[A-Za-z]+|--\S+))*\s+-[A-Za-z]*c[A-Za-z]*\s+'/.test(segment);
}

/**
 * HEAVY-LOCK-POSITIONAL-192 (Jim MUST 1): an sh shell's options come before its first operand: `c`
 * is the index of its -c option (-1: none), `body` the index of the first operand (the command
 * string with -c, else the script). `-o`/`+o`/`-O`/`+O`, --rcfile and --init-file take a value.
 */
function shOptions(args: string[]): { c: number; body: number } {
  let c = -1; let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--' || a === '-') { i++; break; }
    if (!/^[-+]./.test(a)) break;
    if (/^[-+][oO]$|^--(?:rcfile|init-file)$/.test(a)) { i++; continue; }
    if (c < 0 && SH_DASH_C.test(a)) c = i;
  }
  return { c, body: i };
}

/**
 * HEAVY-LOCK-POSITIONAL-192: a -c body with its positional arguments ($0-$9, ${N}, $@, $*) put in
 * from `params` (params[0] is $0), as the shell running the body expands them:
 * - not inside a single quote, and not after a backslash; a body with a backslash or an inner sh -c
 *   that references a positional is unknown (Jim MUST 2: `bash -c 'bash -c "npm $1" _ test'`);
 * - `$@` inside double quotes is a word per argument (`"$@"`); `$*` there, and both unquoted, join.
 * Returns null (unknown) when a referenced argument is not a plain literal word (a `$`, backtick,
 * quote, space or shell syntax), for a `${N...}` with an operator (`${1:-test}`, Jim SHOULD), and
 * when a positional is assigned to a variable (`x=$1; npm $x`, Jim NIT 1).
 */
function positional(body: string, params: string[]): string | null {
  let unknown = false;
  const lit = (w: string): string => { if (!/^[\w@%+=:,./-]*$/.test(w)) unknown = true; return w; };
  // A backslash or an inner sh -c makes the quoting the lock sees uncertain (words() keeps the `\` of
  // `'\''`): a positional in such a body is unknown, never filled.
  const nest = /\\|\b(?:ba|z|da)?sh(?:\s+-\S+)*\s+-[A-Za-z]*c[A-Za-z]*\s/.test(body);
  let out = ''; let q: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q === "'") { out += c; if (c === "'") q = null; continue; }
    if (c === '\\') { out += c + (body[i + 1] ?? ''); i++; continue; }
    if (c === "'" && !q) { q = c; out += c; continue; }
    if (c === '"') { q = q ? null : c; out += c; continue; }
    const m = c === '$' ? /^\$(?:\{([^}]*)\}|(\d|[@*]))/.exec(body.slice(i)) : null;
    if (!m) { out += c; continue; }
    const r = m[1] ?? m[2];
    if (m[1] !== undefined && !/^(?:\d+|[@*])$/.test(r)) {
      if (/^[#!]?[\d@*]/.test(r)) unknown = true;   // ${1:-x}, ${#1}, ${!1}: an operator on a positional
      out += m[0]; i += m[0].length - 1; continue;   // ${HOME}, ${#}: not a positional
    }
    // x=$1, export x=$1; a NAME= that starts a word (Jim NIT 2: `--test-reporter=$1` is an option).
    if (/(?:^|[\s;&|(){}])[A-Za-z_][A-Za-z0-9_]*=\S*$/.test(out)) unknown = true;
    if (nest) unknown = true;
    const args = params.slice(1).map(lit);
    out += r === '@' && q === '"' ? args.join('" "') : r === '@' || r === '*' ? args.join(' ') : lit(params[Number(r)] ?? '');
    i += m[0].length - 1;
  }
  return unknown ? null : out;
}

/** HEAVY-CLASSIFIER-FP: drop every heredoc BODY (`<<'EOF'` ... `EOF`). The body is data fed to
 *  stdin (a python/node edit script, a file's text), never commands this shell runs, so a line in
 *  it must not be classified. The `<<` line itself stays; the terminator line is dropped too. */
function stripHeredocs(cmd: string, bodies?: string[]): string {
  const lines = cmd.split('\n');
  const out: string[] = [];
  let q: string | null = null;   // quote state carries across lines (a quoted string can span them)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    // Jim's audit: only a REAL heredoc operator counts, found with the same quote-aware scan as
    // segments(): not inside quotes, not a here-string (`<<<`), and preceded by start/space/;|&(
    // so `$((a<<b))` is arithmetic, not a heredoc. `cat<<EOF` therefore stays unstripped: the
    // conservative (old) classification.
    const delims: string[] = [];
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      if (q) { if (c === q && (q === "'" || closesDouble(line, j))) q = null; continue; }   // A-S1, A-S2
      if (opensQuote(line, j, 'sh')) { q = c; continue; }
      if (c === '#' && (j === 0 || /\s/.test(line[j - 1]))) break;   // a comment: nothing after it runs
      if (c !== '<' || line[j + 1] !== '<') continue;
      const before = j === 0 ? '' : line[j - 1];
      if (line[j + 2] === '<' || before === '<' || !(before === '' || /[\s;|&(]/.test(before))) { j += 1; continue; }
      // Inside an open `$(( ... ))` a spaced `<<` is a shift (Jim's follow-up), not a heredoc.
      const head = line.slice(0, j);
      if ((head.match(/\$\(\(/g) ?? []).length > (head.match(/\)\)/g) ?? []).length) { j += 1; continue; }
      const m = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line.slice(j));
      if (m) { delims.push(m[2]); j += m[0].length - 1; }
    }
    if (delims.length) q = null;   // the body starts on the next line whatever the operator line held
    for (const d of delims) {
      i++;
      const start = i;
      while (i < lines.length && lines[i].trim() !== d) i++;
      bodies?.push(lines.slice(start, i).join('\n'));   // HEAVY-LOCK-ADHOC-NODE: a `node <<EOF` script
    }
  }
  return out.join('\n');
}

/** HEAVY-CLASSIFIER-FP: drop redirections and their targets (`2>&1`, `> x.log`, `2>/dev/null`,
 *  `&>x`, `<<EOF`), so a redirect never reads as a positional argument: `node --test a.cjs 2>&1`
 *  used to leave `2>` behind as a "test file" that is not a .js file -> "a glob or a directory". */
function stripRedirects(ws: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    // HEAVY-LOCK-CODEX-EXEC: PowerShell's all-streams redirect `*>` / `*>>` (`*>&1`, `*> x.log`)
    // too; left behind, `*>` and its file read as a suite runner's FILTER, so Dwight's Codex
    // `node test/tools/run-tests.cjs *> full.log` (shell powershell) ran light, unlocked.
    const m = /^(\d*(?:>>?|<<?-?|<>)|&>>?|\*>>?)(&?)(.*)$/.exec(w);
    if (!m) { out.push(w); continue; }
    // Operator with its target attached (`>x.log`, `2>&1`, `<<EOF`): drop just this word.
    // A bare operator (`>`, `2>`, `<<`): its target is the next word; drop both.
    if (!m[3]) i++;
  }
  return out;
}

/** The segments a shell would run: split on ; && || | and newlines, OUTSIDE quotes. */
function segments(cmd: string, d: ShellDialect = 'sh'): string[] {
  const out: string[] = [];
  let cur = ''; let q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    // HEAVY-JOB-LOCK-FAILOPEN: a command substitution is opaque (its pipes and quotes are its own).
    if (d === 'sh' && q !== "'" && c === '$' && cmd[i + 1] === '(') { const e = substEnd(cmd, i); cur += cmd.slice(i, e); i = e - 1; continue; }
    // HEAVY-LOCK-CMD-QUOTED-CARET-198: cmd reads a script line by line, and a quote still open at
    // the end of a line ends there (a `^` inside it is literal, so it continues nothing): in
    // `echo "abc^` + newline + `npm test`, real cmd runs npm test. The newline separates.
    if (q && d === 'cmd' && c === '\n') { q = null; out.push(cur); cur = ''; continue; }
    // A-S1: `'` closes at the next `'` unconditionally (a backslash escapes nothing inside it), and
    // cmd has no backslash escape at all; only inside sh's "..." does `\"` stay open.
    if (q) { cur += c; if (c === q && (q === "'" || d === 'cmd' || closesDouble(cmd, i))) q = null; continue; }
    if (opensQuote(cmd, i, d)) { q = c; cur += c; continue; }
    // cmd's `^` escapes the next character (`^&` is a literal &, not a separator).
    if (d === 'cmd' && c === '^') { cur += c + (cmd[i + 1] ?? ''); i++; continue; }
    if (d === 'cmd' && c === ';') { cur += c; continue; }   // not a separator in cmd
    // HEAVY-CLASSIFIER-EDGES N2: an unquoted `#` at a word start comments out the rest of the line
    // (an apostrophe in a comment used to open a "quote" that swallowed the following lines).
    if (d === 'sh' && c === '#' && (i === 0 || /\s/.test(cmd[i - 1]))) { while (i + 1 < cmd.length && cmd[i + 1] !== '\n') i++; continue; }
    // A redirection's `&` (`2>&1`, `>&2`, `&>x`, `<&0`) is not a separator or a background `&`.
    if (c === '&' && (cmd[i - 1] === '>' || cmd[i - 1] === '<' || cmd[i + 1] === '>')) { cur += c; continue; }
    // sh's clobber redirect `>|` (and `2>|`) is one operator, not a `>` then a pipe.
    if (d === 'sh' && c === '|' && cmd[i - 1] === '>') { cur += c; continue; }
    // HEAVY-LOCK-LIVE-FILE-192 (b): a lone `&` that starts a command backgrounds nothing; it is
    // PowerShell's call operator (`& "$p" K3`), kept as a word so the program it calls is classified.
    if (c === '&' && !cur.trim() && cmd[i + 1] !== '&') { cur += '& '; continue; }
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      if (c === '&' && cmd[i + 1] !== '&' && cmd[i - 1] !== '&') { cur += ' &'; out.push(cur); cur = ''; continue; } // a lone & = background
      out.push(cur); cur = '';
      if ((c === '&' || c === '|') && cmd[i + 1] === c) i++;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

const WRAPPERS = new Set(['bash', 'sh', 'dash', 'zsh', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'bash.exe']);
/** HEAVY-LOCK-POSITIONAL-192: the WRAPPERS that are sh shells (their -c may be combined: `-lc`). */
const SH_BINS = new Set(['bash', 'sh', 'dash', 'zsh', 'bash.exe']);
/** The binaries a wrapper script can be asked to run (`node clean-run.cjs <bin> ...`). */
const WRAPPED_BINS = new Set(['node', 'npm', 'npx', 'pnpm', 'yarn', 'electron', 'electron-builder', 'electron-rebuild', 'node-gyp', 'vitest', 'env', 'timeout', 'nice']);
const BENCH_SCRIPT = /(mutant|mutation|replay|bench|backfill|parity|speed|stress|soak)[^\\/]*\.(c?m?js|ts)$/i;
export const SUITE_MANY_FILES = 20;
/** A whole-suite runner script (heavy when run with no filter). */
const SUITE_RUNNER = /(^|[\\/])(run-?tests?|test-?runner|run-?all(-?tests)?)\.[cm]?[jt]s$/i;
/** Jim MF2: an opt-in scale/bench gate in the env prefix (THREAD_VIEW_SCALE=1 node --test x) makes
 *  even a single test file a bench. */
// HEAVY-SLOT-EXCLUSIVE-192: EXCLUSIVE is the explicit marker (`GUPPY_HEAVY_EXCLUSIVE=1 <cmd>`): a bench, so it runs alone.
const BENCH_ENV = /^[A-Z0-9_]*(SCALE|BENCH|STRESS|SOAK|EXCLUSIVE)[A-Z0-9_]*=(1|true|yes|on)$/i;
/** node flags that take their value as the NEXT argument (so that value is not a test file).
 *  HEAVY-LOCK-NODE-FLAGS-COMPLETE: every `=...` option of `node --help` (node 20.19.5), each
 *  MEASURED: `node F VALUE s.cjs` runs s.cjs, so F consumed VALUE (or, for --policy-integrity,
 *  --snapshot-blob, --build-snapshot-config and --experimental-sea-config, the separate and `=`
 *  forms fail alike on that value). `[=...]` options (--inspect, --inspect-brk, --inspect-wait)
 *  take a value only with `=`: measured, `node --inspect-brk s.cjs` debugs s.cjs. */
const NODE_VALUE_FLAGS = new Set([
  '--test-name-pattern', '--test-skip-pattern', '--test-reporter', '--test-reporter-destination', '--test-concurrency', '--test-timeout', '--test-shard',
  '--import', '--require', '-r', '--loader', '--experimental-loader', '--env-file', '--env-file-if-exists', '--conditions', '-C', '--input-type',
  '--allow-fs-read', '--allow-fs-write', '--build-snapshot-config', '--cpu-prof-dir', '--cpu-prof-interval', '--cpu-prof-name',
  '--diagnostic-dir', '--disable-proto', '--disable-warning', '--dns-result-order', '--experimental-default-type', '--experimental-policy',
  '--experimental-sea-config', '--heap-prof-dir', '--heap-prof-interval', '--heap-prof-name', '--heapsnapshot-near-heap-limit',
  '--heapsnapshot-signal', '--icu-data-dir', '--inspect-port', '--debug-port', '--inspect-publish-uid', '--max-http-header-size',
  '--network-family-autoselection-attempt-timeout', '--openssl-config', '--policy-integrity', '--redirect-warnings', '--report-dir',
  '--report-directory', '--report-filename', '--report-signal', '--secure-heap', '--secure-heap-min', '--snapshot-blob', '--title',
  '--tls-cipher-list', '--tls-keylog', '--trace-event-categories', '--trace-event-file-pattern', '--trace-require-module',
  '--unhandled-rejections', '--use-largepages', '--v8-pool-size', '--watch-path',
]);

/** Strip the prefixes that do not change what runs: VAR=x, env [-u X]..., timeout N, nice, cd x. */
function leading(ws: string[]): string[] {
  let i = 0;
  while (i < ws.length) {
    const w = ws[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i++; continue; }
    // HEAVY-LOCK-MISSED-RUNS-177 (3rd escape): an opaque `$(...)` in env's option run expands to
    // options (`env $(env | grep ... | sed s/^/-u /) node test/tools/run-tests.cjs`); it is not the program.
    if (w === 'env') { i++; while (i < ws.length && (ws[i].startsWith('-') || ws[i].startsWith('$(') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[i]))) { if (ws[i] === '-u') i++; i++; } continue; }
    if (w === 'timeout' || w === 'nice') { i++; while (i < ws.length && (/^-/.test(ws[i]) || /^\d+[smhd]?$/.test(ws[i]))) i++; continue; }
    // HEAVY-LOCK-SHAPES-189 (Jim MUST 1): `nohup npm test &`, `time npm test`, `setsid npm test` run what follows.
    if (w === 'nohup' || w === 'time' || w === 'setsid') { i++; while (i < ws.length && /^-/.test(ws[i])) i++; continue; }
    // HEAVY-LOCK-EXEC-POSITIONAL: `exec npm test` (`sh -c 'exec "$@"' _ npm test`) and `command npm test`
    // run what follows; `exec -a NAME` takes a value, `command -v`/`-V` only looks the name up.
    if (w === 'exec') { i++; while (i < ws.length && /^-/.test(ws[i])) { if (/^-[cl]*a$/.test(ws[i])) i++; i++; } continue; }
    // Jim NIT (44024f): `builtin exec npm test` runs the exec builtin.
    if (w === 'builtin') { i++; continue; }
    if (w === 'command') { i++; while (i < ws.length && /^-/.test(ws[i])) { if (/[vV]/.test(ws[i])) return []; i++; } continue; }
    if (w === 'cd' || w === 'pushd') return []; // `cd x` alone is its own segment
    break;
  }
  return ws.slice(i);
}

/**
 * HEAVY-LOCK-OPAQUE-SCRIPT-196 (Jim MUST A): the `node --test` runs a command IS, each as its file
 * arguments ([] = no files: node's own discovery, a suite; ANY_TEST_FILE for an argument the shell
 * expands, `test/$f.test.cjs` in a loop), or null when it has none, or when any other segment is a
 * program that can itself start a shell-parented node --test (a script, node, npm, make, anything
 * not known to be quiet). A command that only MENTIONS the files (`node gen-mut.cjs muts.json root
 * test/a.cjs`) is null, so a test process it spawns can never match it; `npx tsc --noEmit && node
 * --test a.cjs` and a per-file `for` loop are their test runs (Jim MUST 1). `bash -c` /
 * `powershell -Command` bodies and `$(...)` substitutions are followed (Codex wraps its calls).
 */
export function testInvocation(command: string): string[][] | null {
  const r = invocationOf(command, 0);
  return r.launches || !r.runs.length ? null : r.runs;
}
export const ANY_TEST_FILE = '<any>';
/** Programs that never start a node --test of their own (beside a call's own run, they leave it its run). */
const QUIET_BINS = new Set(['cd', 'pushd', 'popd', 'export', 'unset', 'set', 'local', 'read', 'shift', 'exit', 'return', 'break', 'continue',
  'echo', 'printf', 'date', 'sleep', 'true', 'false', 'test', '[', '[[', 'grep', 'egrep', 'fgrep', 'rg', 'tail', 'head', 'cat', 'wc', 'sed',
  'awk', 'sort', 'uniq', 'tr', 'cut', 'tee', 'ls', 'pwd', 'git', 'tsc', 'which', 'type', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'jq', 'diff',
  'cmp', 'basename', 'dirname', 'realpath', 'stat', 'du', 'df', 'ps', 'tasklist', 'whoami', 'hostname', 'write-output', 'write-host',
  'get-date', 'select-string', 'select-object', 'measure-object', 'out-null']);
/** `npx <tool>` for a tool that runs no tests. */
const QUIET_NPX = new Set(['tsc', 'eslint', 'prettier']);
const SHELL_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'while', 'until', 'if', '!', '{', '}', '(', ')', 'time', 'done', 'fi', 'esac']);
function invocationOf(command: string, depth: number): { runs: string[][]; launches: boolean } {
  const runs: string[][] = [];
  const deeper = (body: string): boolean => {
    if (depth >= MAX_DEPTH) return true;
    const inner = invocationOf(body, depth + 1);
    runs.push(...inner.runs);
    return inner.launches;
  };
  for (const seg of segments(stripHeredocs(command))) {
    // A `$(...)` substitution is a command of its own (`r=$(node --test "$f" | tail -1)`).
    for (let i = 0, q = false; i < seg.length; i++) {
      if (seg[i] === "'") q = !q;
      else if (!q && seg[i] === '$' && seg[i + 1] === '(') { const e = substEnd(seg, i); if (deeper(seg.slice(i + 2, e - 1))) return { runs, launches: true }; i = e - 1; }
    }
    let ws = leading(stripRedirects(words(seg.replace(/\s&$/, ''))));
    while (ws.length && SHELL_KEYWORDS.has(ws[0])) ws = leading(ws.slice(1));
    // A loop header (`for f in a b`, `case $x in`) runs nothing itself.
    if (!ws.length || ws[0] === 'for' || ws[0] === 'case') continue;
    const bin = ws[0].replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.(exe|cmd)$/, '');
    if (WRAPPERS.has(bin)) {
      const k = ws.findIndex((a, i) => i > 0 && /^(-l?c|\/\/?c|-command)$/i.test(a));
      // `bash x.sh` runs a script the lock cannot read: it launches.
      if (k <= 0 || deeper(ws.slice(k + 1).join(' '))) return { runs, launches: true };
      continue;
    }
    if (QUIET_BINS.has(bin) || (bin === 'npx' && QUIET_NPX.has((ws[1] ?? '').toLowerCase()))) continue;
    if (bin !== 'node') return { runs, launches: true };
    const files: string[] = [];
    let test = false;
    for (let i = 1; i < ws.length; i++) {
      const w = ws[i];
      // `node x.cjs --test` passes --test to x.cjs: node's own flags come before the script.
      if (w === '--test' && !files.length) { test = true; continue; }
      if (w.startsWith('-')) { if (NODE_VALUE_FLAGS.has(w)) i++; continue; }
      // `node --test` runs the files; anything after a non-flag is still a file argument.
      files.push(/[$`*?]/.test(w) ? ANY_TEST_FILE : w);
    }
    if (!test) return { runs, launches: true };
    runs.push(files);
  }
  return { runs, launches: false };
}

/** HEAVY-LOCK-SCRIPT-WRAPPER: what the classifier may read besides the command line. */
export interface ClassifyCtx {
  /** HEAVY-LOCK-GLOB-LOOP-196: this segment is one iteration of a short loop, its variable replaced
   *  by a word: a test file named through it is a computed name (not read; see node --test). */
  loopWord?: boolean;
  /** HEAVY-LOCK-CMD-FOR-198: how many times the enclosing cmd FOR loops run this text (nested lists
   *  multiply, as loopPlan's `mult` does for sh). Absent = 1. */
  loopMult?: number;
  /** The text of a script file the command runs (`bash suite.sh`, `./gate.sh`), resolved against the
   *  call's cwd and size-capped by the caller; null when unreadable. Absent = scripts are not read. */
  readScript?: (path: string, cd?: string) => string | null;
  /** The directory an earlier `cd X` segment of the same command moved to (relative paths then resolve there). */
  cd?: string;
  /** HEAVY-LOCK-ADHOC-NODE, set per segment by classifyCommand: the segment reads stdin from a heredoc
   *  (its body) or a `< file` (its text; null when unreadable). Absent = no stdin redirect. */
  stdin?: string | null;
  /** HEAVY-LOCK-APOSTROPHE-SWALLOW: the quoting rules of this text ('cmd' for a `cmd /c` body). Default 'sh'. */
  dialect?: ShellDialect;
  /** HEAVY-LOCK-SHAPES-189: the agent's spawn env for the variables a script path is commonly built
   *  from (HOME, USERPROFILE, TEMP, TMP, ...): `bash $TEMP/x.sh`, `bash ~/x.sh` read that file. A
   *  variable the command itself assigns wins. Absent = such a path stays unreadable (fail closed). */
  env?: Readonly<Record<string, string>>;
  /** HEAVY-LOCK-FALSE-HEAVY-198, set by classifyCommand: a word with the variables this command set
   *  to a literal (and the spawn env) substituted, as the shell will (`f=x.test.cjs && node --test $f`).
   *  HEAVY-LOCK-LIVE-FILE-192: so a program named through `$S` is judged by the path it names. */
  expand?: (word: string) => string;
  /** HEAVY-LOCK-FALSE-HEAVY-198 (Jim, god 2d273e): where a path readScript resolves to has no file,
   *  that absolute path (for the deny text: "no such file at ..."); null when one is there, or when
   *  the path is not resolvable. Absent = the reason stays "cannot read yet". */
  missingAt?: (path: string, cd?: string) => string | null;
  /** Command-local literal assignments expanded before a nested wrapper is classified. Computed
   * values remain visibly computed, so the wrapper still fails closed. */
  expandKnown?: (text: string) => string;
  /** Raw current segment, retained solely to identify a single-quoted sh `-c` body. */
  segment?: string;
}

/** HEAVY-LOCK-LIVE-FILE-192: a word still computed after expansion (a variable the command did not
 *  set, `$(...)`, a backtick, a PowerShell subexpression). */
const COMPUTED = /[$`]/;

/** HEAVY-LOCK-LIVE-FILE-192: what `word` names, expanded; null when that is still computed. */
function named(word: string, ctx: ClassifyCtx): string | null {
  const w = word.replace(/^["']|["']$/g, '');
  const x = COMPUTED.test(w) && ctx.expand ? ctx.expand(w) : w;
  return COMPUTED.test(x) ? null : x;
}

/** HEAVY-LOCK-LIVE-FILE-192 (b): a program reached through a path the lock cannot name is unknown:
 *  heavy, provisional, as an unreadable script is. */
function unnamed(what: string): HeavyClass {
  return { heavy: true, kind: 'bench', why: `${what} (a path the lock cannot name)`, provisional: true };
}

/** HEAVY-LOCK-SHAPES-189: the nesting a classification follows (`bash -c "bash -c 'bash x.sh'"`, a
 *  script that runs a script); deeper is light, so a script that runs itself still ends. */
const MAX_DEPTH = 4;

/** HEAVY-LOCK-BG-LAPSE-189: the class of a script the lock cannot read at PreToolUse. */
function unreadable(path: string, ctx?: ClassifyCtx): HeavyClass {
  // HEAVY-LOCK-FALSE-HEAVY-198 (Jim): a mistyped path says so, so the agent fixes it rather than waits.
  let at: string | null = null;
  try { at = ctx?.missingAt?.(path, ctx.cd) ?? null; } catch { at = null; }
  return { heavy: true, kind: 'bench', why: `${path.replace(/\\/g, '/').split('/').pop()} (a script the lock cannot read yet${at ? `: no such file at ${at}` : ''})`, provisional: true };
}

/** HEAVY-LOCK-SHAPES-189 (Jim NIT 1): nesting past MAX_DEPTH is not followed, so it is unknown:
 *  heavy, provisional (it read as light, so the depth cap failed open). */
function capped(what: string): HeavyClass {
  return { heavy: true, kind: 'bench', why: `${what} (nested deeper than the lock follows)`, provisional: true };
}

/** Classify a command one level down, or `capped` at MAX_DEPTH. */
function nested(cmd: string, depth: number, ctx: ClassifyCtx, what: string): HeavyClass {
  return depth + 1 >= MAX_DEPTH ? capped(what) : classifyCommand(cmd, depth + 1, ctx);
}

/** A UTF-16 BOM as a UTF-8 read sees it (FF FE / FE FF are two invalid bytes) or as a decoder keeps it. */
const UTF16_BOM = /^(��|﻿)/;

/** A script file run by a shell (`bash x.sh`, `./x.sh`) is heavy when its TEXT runs a heavy command. */
function classifyScript(path: string, depth: number, ctx: ClassifyCtx, dialect: ShellDialect = 'sh'): HeavyClass {
  const name = path.replace(/\\/g, '/').split('/').pop()!;
  if (!ctx.readScript) return { heavy: false };
  if (depth >= MAX_DEPTH) return capped(name);
  let text: string | null = null;
  try { text = ctx.readScript(path, ctx.cd); } catch { text = null; }
  // HEAVY-LOCK-BG-LAPSE-189: a script the lock cannot read (not created yet, too big, a computed
  // path) is an unknown program: heavy, as an unreadable stdin script already is (FAILOPEN).
  if (text === null) return unreadable(path, ctx);
  // HEAVY-LOCK-SHAPES-189 (Jim MUST 2): PowerShell 5.1's Out-File and `>` write UTF-16LE with a BOM,
  // so a .ps1 holds a NUL beside every ASCII character. Decoded first (a command is ASCII, so the
  // NULs go), and a named script (x.ps1, x.sh, x.bat) with NULs and no BOM is UTF-16 too.
  if (text.includes('\0') && (UTF16_BOM.test(text) || name.includes('.'))) text = text.replace(UTF16_BOM, '').replace(/\0/g, '');
  // HEAVY-LOCK-SHAPES-189: a binary (an extensionless `./tool` that is an executable) is not a script.
  if (text.includes('\0')) return { heavy: false };
  // An extensionless script run directly (`./run`) runs by its shebang: node code is node's to judge.
  if (/^#![^\n]*\b(node|tsx|ts-node)\b/.test(text)) {
    const c = classifyNodeCode({ script: path, preloads: [], inline: null, stdin: false }, ctx, true);
    return c.heavy ? c : { heavy: false };
  }
  const c = classifyCommand(text, depth + 1, { ...ctx, dialect });
  return c.heavy ? { ...c, why: `${c.why ?? c.kind} (in ${path.replace(/\\/g, '/').split('/').pop()})` } : { heavy: false };
}

/**
 * HEAVY-LOCK-ADHOC-NODE: an ad-hoc node script is heavy by what it LOADS, not by its name.
 * `node m4opt-costs.cjs` that requires onnxruntime-node and the embedder pins every core for
 * minutes, yet only a bench-like NAME or a wrapped suite made `node <script>` heavy, so such scripts
 * ran beside a held slot. The script is read through the same size-capped reader as shell scripts and
 * TOKENISED (linear: comments dropped, strings kept whole), and only the arguments of a load or spawn
 * call count (Jim's audit: a marker in a comment, a mail body or a regex `.exec(` is not a load):
 *   - the first argument of require( / loadTs( / import( / a createRequire()-made require, the string
 *     of `from '…'` and of a side-effect `import '…'`;
 *   - the arguments of child_process spawn / spawnSync / exec / execSync / execFile / execFileSync /
 *     fork (a `.exec(` on anything but child_process is RegExp's), with simple string constants resolved;
 *   - ELECTRON_RUN_AS_NODE only as an object key or an assignment target.
 * Relative, `path.join(__dirname, …)` and absolute helpers are followed two hops (at most
 * HEAVY_JS_MAX_FILES files read); `--require`/`--import` preloads, `-e`/`--eval=` code and a heredoc or
 * `<` stdin script are checked the same way. Limits (documented): a helper path built at run time from
 * other variables, a spawned script named only through a computed value, a load inside a template
 * literal's `${…}` (those parts are skipped), a destructured child_process alias
 * (`const { spawnSync: run } = require('child_process')`), `node` fed by a pipe with no `-`, and
 * loaders other than node, tsx and ts-node.
 */
// HEAVY-LOCK-LIVE-FILE-192 (a): the Electron harness runner launches a real Electron (and renderer).
const JS_MARKER = /onnxruntime(?:-node|-web)?|@(?:huggingface|xenova)\/transformers|nativeMemory\/+(?:embedder|engine)\b|claims-drill|claims-bed\/+run\b|test\/+tools\/+run-tests|electron-harness\/+run\b/;
/** HEAVY-LOCK-LIVE-FILE-192 (a): a script that DECLARES itself live (it spawns real CLIs or native
 *  helpers, or does sustained work the scan cannot see), in a comment near its top:
 *  `// @heavy-lock live`, a line of its own (or of a block comment). Read from the raw text (the
 *  tokenizer drops comments); a string that merely holds the words is not a declaration. */
const LIVE_TAG = /^[ \t]*(?:\/\/+|\/?\*+)[ \t]*@heavy-lock[: \t]+live\b/m;
const LIVE_TAG_CHARS = 4096;
/** A spawned `node --test`'s options that take the next element as their value. */
const TEST_VALUED = /^(--test-(name-pattern|skip-pattern|reporter|reporter-destination|concurrency|timeout|shard|coverage-include|coverage-exclude)|--(import|require|loader|experimental-loader|env-file)|-r)$/;
/** HEAVY-LOCK-LIVE-FILE-192 (a): test/perf's wall-clock gates (CLAIMS-PERF-LANE) are benches. */
const PERF_FILE = /\.perf\.[cm]?js$/i;
const JS_SPAWN = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
/** A script node runs: .js/.cjs/.mjs/.ts (also .cts/.mts). */
const JS_SCRIPT = /\.[cm]?[jt]s$/i;
/** At most this many files are read for one command (the script, its preloads and its helpers). */
export const HEAVY_JS_MAX_FILES = 8;
/** At most this much of one file is tokenised (Jim P1: the scan runs on the main process's hook path). */
export const HEAVY_JS_SCAN_CHARS = 256 * 1024;
/** A call's arguments are read at most this many tokens deep (bounds a line of unclosed `require(`). */
const JS_ARG_TOKENS = 64;

type JsTok = { t: 'id' | 'str' | 'p' | 're'; v: string };

/** A linear JS tokenizer, just enough for load calls: identifiers, string literals (a template's
 *  `${…}` parts dropped), punctuation. Comments are skipped; a regex literal is skipped whole. */
function jsTokens(src: string): JsTok[] {
  const s = src.length > HEAVY_JS_SCAN_CHARS ? src.slice(0, HEAVY_JS_SCAN_CHARS) : src;
  const out: JsTok[] = [];
  const idStart = (ch: number): boolean => (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95 || ch === 36;
  const idPart = (ch: number): boolean => idStart(ch) || (ch >= 48 && ch <= 57);
  // Jim N1: a hashbang line (`#!/usr/bin/env node`) is a comment.
  let i = s.startsWith('#!') ? Math.max(0, s.indexOf('\n')) : 0;
  if (s.startsWith('#!') && i === 0) i = s.length;
  while (i < s.length) {
    const c = s[i]; const code = s.charCodeAt(i);
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '/' && s[i + 1] === '/') { const e = s.indexOf('\n', i); i = e < 0 ? s.length : e; continue; }
    if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let v = ''; i++;
      while (i < s.length && s[i] !== c) {
        if (s[i] === '\\') { v += s[i + 1] ?? ''; i += 2; continue; }
        if (c === '`' && s[i] === '$' && s[i + 1] === '{') { let d = 1; i += 2; while (i < s.length && d) { if (s[i] === '{') d++; else if (s[i] === '}') d--; i++; } continue; }
        if (c !== '`' && s[i] === '\n') break;
        v += s[i]; i++;
      }
      i++; out.push({ t: 'str', v }); continue;
    }
    if (idStart(code)) { let j = i + 1; while (j < s.length && idPart(s.charCodeAt(j))) j++; out.push({ t: 'id', v: s.slice(i, j) }); i = j; continue; }
    if (c === '/') {
      const p = out[out.length - 1];
      if (!p || (p.t === 'p' && '(,=:[!&|?{};'.includes(p.v)) || (p.t === 'id' && (p.v === 'return' || p.v === 'typeof' || p.v === 'case'))) {
        let j = i + 1; let cls = false;
        while (j < s.length && s[j] !== '\n') { if (s[j] === '\\') { j += 2; continue; } if (s[j] === '[') cls = true; else if (s[j] === ']') cls = false; else if (s[j] === '/' && !cls) break; j++; }
        // Jim N1: only a regex CLOSED on its line is one (else this '/' is punctuation), and it leaves
        // a token, so a '/' right after it reads as division, never as another regex start.
        if (j < s.length && s[j] === '/') {
          i = j + 1; while (i < s.length && idPart(s.charCodeAt(i))) i++;
          out.push({ t: 're', v: '' });
          continue;
        }
      }
    }
    out.push({ t: 'p', v: c }); i++;
  }
  return out;
}

/** `a/lib/../util.js` -> `a/util.js` (forward slashes; a leading `..` that cannot be removed stays). */
function normPath(p: string): string {
  const out: string[] = [];
  for (const s of p.replace(/^["']|["']$/g, '').replace(/\\/g, '/').split('/')) {
    if (s === '.') continue;
    if (s === '..' && out.length && out[out.length - 1] !== '..' && out[out.length - 1] !== '' && !/^[A-Za-z]:$/.test(out[out.length - 1])) { out.pop(); continue; }
    out.push(s);
  }
  return out.join('/') || '.';
}

/** What a script's text loads: the first heavy marker (or null) and the helper paths to read next. */
function scanJs(text: string): { marker: string | null; helpers: string[]; tests?: string[] } {
  const ts = jsTokens(text);
  const helpers: string[] = [];
  const tests: string[] = [];
  const consts = new Map<string, string>();
  const requires = new Set(['require', 'loadTs']);
  // `const s = '…'` (string constants a spawn may name) and `const req = createRequire(…)`.
  for (let k = 0; k + 3 < ts.length; k++) {
    if (ts[k].t !== 'id' || !/^(const|let|var)$/.test(ts[k].v) || ts[k + 1].t !== 'id' || ts[k + 2].v !== '=') continue;
    if (ts[k + 3].t === 'str' && ts[k + 4]?.v !== '+' && ts[k + 4]?.v !== '.') consts.set(ts[k + 1].v, ts[k + 3].v);
    if (ts[k + 3].t === 'id' && ts[k + 3].v === 'createRequire') requires.add(ts[k + 1].v);
  }
  /** The tokens of a call's first argument and of all its arguments; ts[open] is '('. */
  const call = (open: number): { first: JsTok[]; all: JsTok[]; end: number } => {
    let d = 0; let j = open; let firstEnd = -1;
    const stop = Math.min(ts.length, open + JS_ARG_TOKENS);
    for (; j < stop; j++) {
      const v = ts[j].t === 'p' ? ts[j].v : '';
      if (v === '(' || v === '[' || v === '{') d++;
      else if (v === ')' || v === ']' || v === '}') { d--; if (d === 0) break; }
      else if (v === ',' && d === 1 && firstEnd < 0) firstEnd = j;
    }
    return { first: ts.slice(open + 1, firstEnd < 0 ? j : firstEnd), all: ts.slice(open + 1, j), end: j };
  };
  const norm = (v: string): string => v.replace(/\\/g, '/');
  /** A marker in the argument: a string in it, or the argument's text joined (a shell may strip `-e` quotes). */
  const markerIn = (xs: JsTok[]): string | null => {
    for (const x of xs) { const m = x.t === 'str' ? JS_MARKER.exec(norm(x.v)) : null; if (m) return m[0]; }
    const m = JS_MARKER.exec(norm(xs.map((x) => x.v).join('')));
    return m ? m[0] : null;
  };
  const helperOf = (xs: JsTok[]): void => {
    const strs = xs.filter((x) => x.t === 'str').map((x) => norm(x.v));
    if (!strs.length) return;
    if (xs.some((x) => x.t === 'id' && x.v === '__dirname')) { helpers.push(`./${strs.join('/')}`); return; }
    if (/^\.{1,2}\//.test(strs[0])) helpers.push(strs[0]);
    else if (/^([A-Za-z]:)?\//.test(strs[0])) helpers.push(strs[0]);
  };
  const load = (xs: JsTok[]): string | null => { const m = markerIn(xs); if (!m) helperOf(xs); return m; };
  for (let k = 0; k < ts.length; k++) {
    const x = ts[k]; const nx = ts[k + 1]; const pv = ts[k - 1];
    const dotted = pv?.t === 'p' && pv.v === '.';
    if (x.v === 'ELECTRON_RUN_AS_NODE' && (x.t === 'id' || x.t === 'str')) {
      const after = x.t === 'str' && nx?.v === ']' ? 2 : 1;   // env['ELECTRON_RUN_AS_NODE'] = …
      const op = ts[k + after]; const op2 = ts[k + after + 1];
      if (op?.t === 'p' && (op.v === ':' || (op.v === '=' && op2?.v !== '='))) return { marker: 'ELECTRON_RUN_AS_NODE', helpers };
      continue;
    }
    if (x.t !== 'id') continue;
    if (requires.has(x.v) && !dotted && nx?.v === '(') { const m = load(call(k + 1).first); if (m) return { marker: m, helpers }; continue; }
    if (x.v === 'import' && !dotted) {
      if (nx?.v === '(') { const m = load(call(k + 1).first); if (m) return { marker: m, helpers }; }
      else if (nx?.t === 'str') { const m = load([nx]); if (m) return { marker: m, helpers }; }   // import 'x' (side effects)
      continue;
    }
    if (x.v === 'from' && nx?.t === 'str') { const m = load([nx]); if (m) return { marker: m, helpers }; continue; }
    if (x.v === 'createRequire' && nx?.v === '(') {
      const c = call(k + 1);
      if (ts[c.end + 1]?.v === '(') { const m = load(call(c.end + 1).first); if (m) return { marker: m, helpers }; }
      continue;
    }
    if (JS_SPAWN.has(x.v) && nx?.v === '(') {
      const owner = dotted ? ts[k - 2]?.v ?? '' : '';
      if (x.v === 'exec' && dotted && !/^(child_process|cp|childProcess)$/.test(owner)) continue;   // RegExp#exec
      const args = call(k + 1).all.map((a) => (a.t === 'id' && consts.has(a.v) ? { t: 'str' as const, v: consts.get(a.v)! } : a));
      for (let j = 0; j < args.length; j++) {
        const a = args[j];
        if (a.t !== 'str') continue;
        // HEAVY-LOCK-LIVE-FILE-192: a script that spawns `node --test` runs the file it names: a named
        // file is read like a helper; a computed one (a mutant or repeat loop's `['--test', file]`) is
        // unknown work. `__filename` is this file, already read.
        if (a.v === '--test') {
          // The elements after it, to the end of the list: options (and a valued one's value) pass.
          const els: JsTok[][] = [[]];
          for (let d = 0, i = j + 1; i < args.length; i++) {
            const b = args[i];
            if (b.t === 'p' && '([{'.includes(b.v)) d++;
            if (b.t === 'p' && ')]}'.includes(b.v) && --d < 0) break;
            if (d === 0 && b.t === 'p' && b.v === ',') els.push([]); else els[els.length - 1].push(b);
          }
          let computed = false;
          for (let e = 0; e < els.length; e++) {
            const [x0, ...rest] = els[e];
            if (!x0) continue;
            const one = !rest.length;
            if (one && x0.t === 'str' && x0.v.startsWith('-')) { if (TEST_VALUED.test(x0.v)) e++; continue; }
            if (one && x0.t === 'str') { if (JS_SCRIPT.test(x0.v)) tests.push(x0.v); continue; }
            if (one && x0.v === '__filename') continue;
            computed = true;
          }
          if (computed) return { marker: 'spawns node --test of a computed file', helpers };
          continue;
        }
        const m = JS_MARKER.exec(norm(a.v)) ?? /\bELECTRON_RUN_AS_NODE=/.exec(a.v);
        if (m) return { marker: m[0].replace(/=$/, ''), helpers };
      }
    }
  }
  return { marker: null, helpers, tests };
}

/** HEAVY-LOCK-ADHOC-NODE: the program `node …` will run (script, preloads, inline or stdin code). */
interface NodeProgram { script: string | null; preloads: string[]; inline: string | null; stdin: boolean }

/**
 * HEAVY-LOCK-NODE-FLAGS-COMPLETE: every `-r`/`--require`/`--import` value up to the script. A preload
 * runs before the program, so a suite runner or bench script preloaded is the suite or the bench.
 * Measured: `node -e 1 -r ./pre.cjs` still preloads (options go on after -e code); `node s.cjs -r x`
 * does not (after the script it is argv).
 */
function nodePreloads(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = /^(--require|-r|--import)=(.+)$/.exec(a);
    if (eq) { out.push(eq[2]); continue; }
    if (/^(--require|-r|--import)$/.test(a)) { if (args[i + 1]) out.push(args[i + 1]); i++; continue; }
    if (/^(-e|--eval|-p|--print)$/.test(a)) { i++; continue; }
    if (a === '-') break;
    if (a.startsWith('-')) { if (NODE_VALUE_FLAGS.has(a)) i++; continue; }
    break;
  }
  return out;
}

/** The index of node's script argument (-1 for `-e`/`-p` code, stdin `-`, or none). */
function nodeScriptIndex(args: string[]): number {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^(-e|--eval|-p|--print)(=|$)/.test(a) || a === '-') return -1;
    if (a.startsWith('-')) { if (NODE_VALUE_FLAGS.has(a)) i++; continue; }
    return i;
  }
  return -1;
}

function nodeProgram(args: string[]): NodeProgram {
  const p: NodeProgram = { script: null, preloads: [], inline: null, stdin: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = /^(--eval|--print|-e|-p)=([\s\S]*)$/.exec(a);
    if (eq) { p.inline = eq[2]; return p; }
    if (/^(-e|--eval|-p|--print)$/.test(a)) { p.inline = args[i + 1] ?? ''; return p; }
    const pre = /^(--require|-r|--import)=(.+)$/.exec(a);
    if (pre) { p.preloads.push(pre[2]); continue; }
    if (/^(--require|-r|--import)$/.test(a)) { if (args[i + 1]) p.preloads.push(args[i + 1]); i++; continue; }
    if (a === '-') { p.stdin = true; return p; }
    if (a.startsWith('-')) { if (NODE_VALUE_FLAGS.has(a)) i++; continue; }
    p.script = a; return p;
  }
  return p;
}

/** Inline code, stdin code, or a script file (plus preloads and helpers, two hops deep) that loads a heavy runtime. */
function classifyNodeCode(prog0: NodeProgram, ctx: ClassifyCtx, anyName = false, maxFiles = HEAVY_JS_MAX_FILES): HeavyClass {
  const hit = (marker: string, where: string): HeavyClass => ({ heavy: true, kind: 'bench', why: `node ${where} (${marker.startsWith('spawns ') ? '' : 'loads '}${marker})` });
  // HEAVY-LOCK-SHAPES-189: node runs an extensionless script as node resolves it (`node run`: the
  // file run, else run.js, else run/index.js); a shebang script (`./run`, anyName) is the file itself.
  // One that does not read stays as before (not judged): the replay showed the name is mostly not a
  // script at all (`"$T" --hide-layer Stuff`, `$E eval 9333` read as `node Stuff` / `node eval`).
  let prog = prog0;
  if (prog.script && !anyName && !JS_SCRIPT.test(prog.script) && ctx.readScript && !prog.script.replace(/\\/g, '/').split('/').pop()!.includes('.')) {
    const s = prog.script;
    for (const p of [s, `${s}.js`, `${s.replace(/[\\/]+$/, '')}/index.js`]) {
      let t: string | null = null;
      try { t = ctx.readScript(p, ctx.cd); } catch { t = null; }
      if (t !== null) { prog = { ...prog, script: p }; anyName = true; break; }
    }
  }
  if (prog.inline !== null) { const m = scanJs(prog.inline).marker; return m ? hit(m, '-e') : { heavy: false }; }
  // A script read from stdin: a heredoc body or a `< file` the classifier could read is checked;
  // stdin it cannot see (`node -` from a pipe, an unreadable `< file`) is an unknown program: heavy.
  if (!prog.script && (prog.stdin || ctx.stdin !== undefined)) {
    if (typeof ctx.stdin === 'string') { const m = scanJs(ctx.stdin).marker; if (m) return hit(m, '(stdin script)'); }
    else return { heavy: true, kind: 'bench', why: 'node (a stdin script the lock cannot read)' };
  }
  if (!ctx.readScript) return { heavy: false };
  const roots = [...prog.preloads, ...(prog.script && (anyName || JS_SCRIPT.test(prog.script)) ? [prog.script] : [])];
  if (!roots.length) return { heavy: false };
  const name = (prog.script ?? roots[0]).replace(/\\/g, '/').split('/').pop()!;
  const seen = new Set<string>();
  const queue: { path: string; hop: number; test?: boolean }[] = roots.map((r) => ({ path: r, hop: 0 }));
  let read = 0; let tries = 0;
  while (queue.length && read < maxFiles && tries < 4 * maxFiles) {
    const { path, hop, test } = queue.shift()!;
    const key = normPath(path);
    if (seen.has(key)) continue;
    seen.add(key);
    tries++;
    let text: string | null = null;
    try { text = ctx.readScript(key, ctx.cd); } catch { text = null; }
    // The path as written (`./pre.cjs`) when the normalised one (`pre.cjs`) did not read.
    if (text === null && path !== key) { try { text = ctx.readScript(path, ctx.cd); } catch { text = null; } }
    // HEAVY-LOCK-BG-LAPSE-189: the script itself (or a preload named by a file path) unreadable is
    // an unknown program: heavy. A helper (hop >= 1) is a guess among extensions: the rest decides.
    if (text === null && hop === 0 && (path === prog.script || /^(\.{1,2}[\\/]|[A-Za-z]:[\\/]|[\\/])/.test(path))) return unreadable(path, ctx);
    if (!text) continue;   // unreadable helper, or an empty file: decided by the rest
    read++;
    const base = key.split('/').pop()!;
    if (hop === 0 || test) {
      if (LIVE_TAG.test(text.slice(0, LIVE_TAG_CHARS))) return { heavy: true, kind: 'bench', why: `node ${base} (declares @heavy-lock live)` };
    }
    const s = scanJs(text);
    if (s.marker) return hit(s.marker, hop === 0 && roots.length === 1 ? name : `${name} via ${key.split('/').pop()}`);
    // A test file it spawns is named from the working directory, and its own tag counts.
    for (const t of s.tests ?? []) queue.push({ path: t, hop: hop + 1, test: true });
    if (hop >= 2) continue;
    const dir = key.includes('/') ? key.slice(0, key.lastIndexOf('/') + 1) : '';
    for (const h of s.helpers) {
      const rel = /^([A-Za-z]:)?\//.test(h) ? h : `${dir}${h}`;
      for (const p of JS_SCRIPT.test(rel) ? [rel] : [`${rel}.cjs`, `${rel}.js`, `${rel}.mjs`, `${rel}.ts`, `${rel}/index.js`]) queue.push({ path: p, hop: hop + 1 });
    }
  }
  return { heavy: false };
}

/** Start-Process's own parameters that take a value (any other `-X` after the program is its switch). */
const START_PROCESS_VALUED = /^-(filepath|argumentlist|args|workingdirectory|windowstyle|redirectstandard(output|error|input)|verb|credential|environment)$/i;

/**
 * The program and arguments a launcher starts, as words: PowerShell `Start-Process` (named
 * -FilePath/-ArgumentList or positional) and cmd `start` (a "" title and /switches skipped).
 * An argument list is split on commas and spaces, with `@(`, `)` and quotes dropped; a
 * parenthesised subexpression (`(Join-Path $d 'x.ps1')`) is computed, so it becomes `$computed`.
 */
function launchedWords(args: string[]): string[] {
  let file: string | undefined;
  const list: string[] = [];
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^-(filepath)$/i.test(a)) { file = args[++i]; continue; }
    if (/^-(argumentlist|args)$/i.test(a)) {
      while (i + 1 < args.length && !START_PROCESS_VALUED.test(args[i + 1]) && !/^-(passthru|wait|nonewwindow|loaduserprofile|usenewenvironment)$/i.test(args[i + 1])) list.push(args[++i]);
      continue;
    }
    if (START_PROCESS_VALUED.test(a)) { i++; continue; }
    if (/^-[a-z]+$/i.test(a) && !file && !positional.length) continue;            // a switch (-PassThru)
    if (/^\/[a-z]+$/i.test(a) && !positional.length) continue;                     // cmd start /b /wait
    if (a === '' && !positional.length && !file) continue;                          // cmd start's "" title
    if (/^-(passthru|wait|nonewwindow|loaduserprofile|usenewenvironment)$/i.test(a)) continue;
    positional.push(a);
  }
  if (!file) file = positional.shift();
  if (!file) return [];
  const rest = [...list, ...positional].join(' ')
    .replace(/@\(/g, ' ')
    .replace(/\([^()]*\)/g, ' $computed ')
    .replace(/[()]/g, ' ')
    .replace(/['"]/g, '')
    .split(/[\s,]+/)
    .filter(Boolean);
  return [file.replace(/^['"]|['"]$/g, ''), ...rest];
}

/** HEAVY-LOCK-SHAPES-189 (Jim MUST 1): a command whose { } argument is a script block it runs: any
 *  Verb-Noun cmdlet (Start-Job, Invoke-Command, ForEach-Object ...), the aliases %, foreach, icm,
 *  sajb, and the call operator &. */
const PS_BLOCK_BIN = /^([a-z]+-[a-z]+|%|foreach|icm|sajb|&)$/;

/** Jim delta SHOULD: the cmdlets whose -FilePath (or -LiteralPath / -PSPath) names a script they
 *  RUN, and that parameter in any unambiguous prefix PowerShell accepts. */
const PS_FILE_RUNNERS = new Set(['start-job', 'sajb', 'start-threadjob', 'invoke-command', 'icm']);
const PS_FILE_PARAM = /^-(f(i(l(e(p(a(t(h)?)?)?)?)?)?)?|li(t(e(r(a(l(p(a(t(h)?)?)?)?)?)?)?)?)?|pspath|lp)$/i;

/** The text inside the first { } of these words (balanced across words), '' for an empty block, or
 *  null when there is no block. */
function scriptBlock(words: string[]): string | null {
  const at = words.findIndex((w) => w.startsWith('{'));
  if (at < 0) return null;
  let depth = 0; const out: string[] = [];
  for (let i = at; i < words.length; i++) {
    out.push(words[i]);
    for (const ch of words[i]) depth += ch === '{' ? 1 : ch === '}' ? -1 : 0;
    if (depth <= 0) break;
  }
  return out.join(' ').replace(/^\{/, '').replace(/\}$/, '').trim();
}

/** HEAVY-LOCK-SHAPES-189 (Jim MUST 1): PowerShell's -EncodedCommand value (base64 of UTF-16LE), or
 *  null when it is not that. */
function decodePsEncoded(value: string | undefined): string | null {
  const s = (value ?? '').replace(/^['"]|['"]$/g, '');
  if (!s || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  const buf = Buffer.from(s, 'base64');
  if (buf.length < 2 || buf.length % 2 !== 0) return null;
  const code = buf.toString('utf16le');
  return /[\0-\x08\x0e-\x1f�]/.test(code) ? null : code;
}

function classifyWords(ws0: string[], depth: number, ctx: ClassifyCtx = {}): HeavyClass {
  const raw = leading(ws0);
  const hasUnclosed = raw.some((w) => w.startsWith('__HEAVY_UNCLOSED_QUOTE__'));
  const ws = raw.map((w) => w.replace(/^__HEAVY_UNCLOSED_QUOTE__/, ''));
  if (!ws.length) return { heavy: false };
  // HEAVY-LOCK-SHAPES-189: a PowerShell assignment runs its right-hand side (`$suite = Start-Process
  // npm.cmd test`, `$r=npm test`); it read as a dynamic command word or a variable.
  const psAssign = /^\$[A-Za-z_][A-Za-z0-9_:]*=(.*)$/.exec(ws[0]);
  if (psAssign) return classifyWords([...(psAssign[1] ? [psAssign[1]] : []), ...ws.slice(1)], depth, ctx);
  if (/^\$[A-Za-z_][A-Za-z0-9_:]*$/.test(ws[0]) && ws[1] === '=') return classifyWords(ws.slice(2), depth, ctx);
  // A dynamic command word is unnameable, but its arguments still identify common heavy runners.
  // Handle variable wrappers (`$CR node ...`), variable Node (`$NODE test/tools/run-tests.cjs`),
  // PowerShell environment variables, and the conventional `$(which node)` form.
  if (/^\$\((?:which|command\s+-v)\s+node\)$/.test(ws[0])) return classifyWords(['node', ...ws.slice(1)], depth, ctx);
  if (/^`(?:which|command\s+-v)\s+node`$/.test(ws[0])) return classifyWords(['node', ...ws.slice(1)], depth, ctx);
  if (/^\$(?:[A-Za-z_][A-Za-z0-9_]*|env:[A-Za-z_][A-Za-z0-9_]*)$/.test(ws[0]) || /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::[-=+?][^}]*)?\}$/.test(ws[0])) {
    // HEAVY-LOCK-LIVE-FILE-192 (b): a program this command named (`p=.../mut.cjs; & $p K3`, PowerShell's
    // `&` being sh's background operator here) is the program it names.
    const program = named(ws[0], ctx);
    if (program !== null && depth + 1 < MAX_DEPTH) return classifyWords([program, ...ws.slice(1)], depth + 1, ctx);
    // An unnamed program alone is unknown (`& $exe`): heavy, provisional.
    if (ws.length === 1) return unnamed(ws[0]);
    if (ws.length > 1) {
      const next = ws[1].replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.(exe|cmd)$/, '');
      if (/^(?:node|npm|pnpm|yarn|npx|electron-vite|electron-builder|electron-rebuild|vitest)$/.test(next)) return classifyWords(ws.slice(1), depth, ctx);
      return classifyWords(['node', ...ws.slice(1)], depth, ctx);
    }
    return { heavy: false };
  }
  // An opt-in scale/bench env gate before the command (Jim MF2).
  const prefix = ws0.slice(0, ws0.length - ws.length);
  const gate = prefix.find((w) => BENCH_ENV.test(w));
  if (gate) return { heavy: true, kind: 'bench', why: `${gate.split('=')[0]} (an opt-in bench gate)` };
  let bin = ws[0].replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.(exe|cmd)$/, '');
  let args = ws.slice(1);
  // busybox sh is a shell wrapper just like its standalone sh/dash siblings.
  if (bin === 'busybox' && /^(?:sh|dash|ash)$/i.test(args[0] ?? '')) { bin = 'sh'; args = args.slice(1); }
  if (hasUnclosed && WRAPPERS.has(bin)) return { heavy: false };
  // cmd.exe /s /c uses doubled outer quotes for one Win32 command string. Reconstruct the inner
  // executable (including paths with spaces) before classifying; ignoring this opaque-looking
  // shape let a wrapped install/test and every later chained segment evade the heavy-job lock.
  const cmdBody = args.indexOf('/c');
  if (bin === 'cmd' && cmdBody >= 0 && args.length === cmdBody + 2) {
    const body = args[cmdBody + 1].replace(/^"|"$/g, '');
    // A `cmd /c` body passed through sh can be a generated batch-path, including `$B` and
    // `$(cygpath ...)`; cmd will expand neither but the outer shell already did.  The same
    // applies to backticks.  Deliberately fail closed: even `cmd /c "echo $(date)"` is
    // provisional because the classifier cannot safely recover the resulting command.
    if ((ctx.dialect === 'sh' && /\$/.test(body)) || /`/.test(body)) return { heavy: true, kind: 'bench', why: 'cmd /c (computed command the lock cannot read)', provisional: true };
    const spacedExe = /^([a-z]:\\.*?\.(?:exe|cmd))\s+(.+)$/i.exec(body);
    return classifyCommand(spacedExe ? `"${spacedExe[1]}" ${spacedExe[2]}` : body, depth + 1, { ...ctx, dialect: 'cmd' });
  }
  // One level of a shell wrapper: bash -c "...", cmd /c ..., powershell -Command ...
  // HEAVY-LOCK-BG-LAPSE-189: the script form is read below depth 0 too (`X="$(bash run.sh)"`,
  // `bash -c "bash run.sh"`); classifyScript stops at depth 2.
  if (WRAPPERS.has(bin)) {
    // -c (sh), /c /k (cmd; Git Bash spells it //c), -Command (PowerShell)
    // HEAVY-LOCK-POSITIONAL-192 (Jim MUST 1): an sh shell takes options only before its first operand
    // (`bash suite.sh -coverage` runs suite.sh), and its command string is the first operand after
    // them (`bash -c -e 'npm test'`).
    const sh = SH_BINS.has(bin) ? shOptions(args) : null;
    const k = sh ? sh.c : args.findIndex((a) => /^(-c|\/\/?c|\/\/?k|-command)$/i.test(a));
    // HEAVY-LOCK-APOSTROPHE-SWALLOW: a cmd body is read with cmd's quoting (`'` is literal there).
    // HEAVY-LOCK-SHAPES-189: nested wrappers are followed to MAX_DEPTH (`bash -c "bash -c '...'"`
    // was read one level deep only).
    if (k >= 0) {
      const from = sh ? sh.body : k + 1;
      const body = (ctx.expandKnown ?? ((text: string) => text))(args.slice(from).join(' '));
      // A command string expanded by a shell is not inspectable after expansion. This covers
      // generated cmd paths (`$B`, `${B}`, `$(cygpath ...)`), shell `$C` indirection, `eval $C`,
      // and `bash`/`dash`/`zsh`/busybox-sh `-c "$(cat run.sh)"`. Deliberately conservative:
      // a rare light expansion also reserves a slot rather than reopening this escape class.
      // A single-quoted `-c` body has no outer-shell expansion; its inner shell is inspected.
      // Known literal variables are expanded above. Any still-computed `$` / backtick fails closed.
      if ((bin === 'cmd' && ((ctx.dialect === 'sh' && /\$/.test(body)) || /`/.test(body))) ||
          ((bin === 'bash' || bin === 'sh' || bin === 'dash' || bin === 'zsh') && ctx.dialect === 'sh' && !singleQuotedDashCBody(ctx.segment, args[k]) && /(?:\$|`)/.test(body))) return { heavy: true, kind: 'bench', why: `${bin} ${args[k]} (computed command the lock cannot read)`, provisional: true };
      // HEAVY-LOCK-POSITIONAL-192: the words after a single-quoted sh -c body are its $0, $1, ...,
      // not commands: `bash -c 'npm "$1"' _ test` runs npm test.
      if (ctx.dialect === 'sh' && singleQuotedDashCBody(ctx.segment, args[k])) {
        const filled = positional((ctx.expandKnown ?? ((text: string) => text))(args[from] ?? ''), args.slice(from + 1));
        if (filled === null) return { heavy: true, kind: 'bench', why: `${bin} ${args[k]} (positional arguments the lock cannot read)`, provisional: true };
        return nested(filled, depth, { ...ctx, dialect: 'sh' }, `${bin} ${args[k]}`);
      }
      return nested(body, depth, { ...ctx, dialect: bin === 'cmd' ? 'cmd' : 'sh' }, `${bin} ${args[k]}`);
    }
    // HEAVY-LOCK-SHAPES-189: `powershell -File x.ps1` runs the script's text.
    if (/^(powershell|pwsh)$/.test(bin)) {
      // Jim MUST 1: -EncodedCommand (-e, -ec, -enc ...) is base64 of UTF-16LE code; code that does not
      // decode is unknown (heavy, provisional).
      const e = args.findIndex((a) => /^-ec$/i.test(a) || (/^-e[a-z]*$/i.test(a) && '-encodedcommand'.startsWith(a.toLowerCase())));
      if (e >= 0) {
        const code = decodePsEncoded(args[e + 1]);
        return code === null
          ? { heavy: true, kind: 'bench', why: `${bin} ${args[e]} (code the lock cannot decode)`, provisional: true }
          : nested(code, depth, ctx, `${bin} ${args[e]}`);
      }
      const f = args.findIndex((a) => /^-(f|file)$/i.test(a));
      return f >= 0 && args[f + 1] ? classifyScript(args[f + 1], depth, ctx) : { heavy: false };
    }
    // HEAVY-LOCK-SCRIPT-WRAPPER: `bash suite.sh` / `sh ./gate.sh`: the script's own text decides.
    // HEAVY-LOCK-EXEC-POSITIONAL (Jim NIT 1): the script is the first operand after the options, so
    // `bash -O extglob suite.sh` runs suite.sh, not "extglob".
    const script = sh ? args[sh.body] : undefined;
    return script ? classifyScript(script, depth, ctx) : { heavy: false };
  }
  // `eval` runs its argument as sh code. A variable/backtick-derived body is unknowable before
  // expansion, while literal text can use the same nested classification as a shell `-c` body.
  if (bin === 'eval') {
    const body = (ctx.expandKnown ?? ((text: string) => text))(args.join(' '));
    if (ctx.dialect === 'sh' && /(?:\$|`)/.test(body)) return { heavy: true, kind: 'bench', why: 'eval (computed command the lock cannot read)', provisional: true };
    return nested(body, depth, { ...ctx, dialect: 'sh' }, 'eval');
  }
  // HEAVY-LOCK-SHAPES-189 (god conv-cbab35, Dwight 18:18:34Z): a launcher runs its program, so the
  // program decides. `Start-Process -FilePath npm.cmd -ArgumentList 'test'` (and `saps`, PowerShell's
  // `start`, cmd's `start "" /b npm test`) started a full suite that the lock read as light.
  if ((bin === 'start-process' || bin === 'saps' || bin === 'start') && args.length) {
    const launched = launchedWords(args);
    if (!launched.length) return { heavy: false };
    return depth + 1 >= MAX_DEPTH ? capped(bin) : classifyWords(launched, depth + 1, ctx);
  }
  // HEAVY-LOCK-SHAPES-189 (Jim MUST 1): Invoke-Expression / iex run their string argument.
  if (bin === 'invoke-expression' || bin === 'iex') {
    const words = args.filter((a) => !/^-command$/i.test(a));
    // Jim delta NIT: computed code (`iex (Get-Content suite.ps1 -Raw)`, `iex $code`) cannot be read,
    // so it is unknown: heavy, provisional, as an undecodable -EncodedCommand is.
    // KNOWN GAP (god, conv-f14fb5): `$sb = [scriptblock]::Create('npm test'); & $sb` reads light;
    // code built at run time is beyond a command-text classifier.
    if (words.length && /^[($]/.test(words[0])) {
      return { heavy: true, kind: 'bench', why: `${bin} ${words[0]} (code the lock cannot read)`, provisional: true };
    }
    const code = words.join(' ');
    return code ? nested(code, depth, ctx, bin) : { heavy: false };
  }
  // Jim delta SHOULD: the script-FILE twin of a script block. `Start-Job -FilePath suite.ps1` and
  // `Invoke-Command -FilePath suite.ps1` run the file, as `./suite.ps1` does. Only the cmdlets that
  // run it: Out-File -FilePath writes one.
  if (PS_FILE_RUNNERS.has(bin)) {
    const f = args.findIndex((a) => PS_FILE_PARAM.test(a));
    if (f >= 0 && args[f + 1]) return classifyScript(args[f + 1], depth, ctx);
  }
  // HEAVY-LOCK-LIVE-FILE-192 (b): PowerShell's call operator runs the program it names (`& $p K3`,
  // `& "C:\...\node.exe" --test x`); it read as the program `&`. A name still computed after the
  // command's own assignments (`& $exe`, `& (Join-Path $d x.ps1)`) is unknown: heavy, provisional.
  if (bin === '&' && args.length && !args[0].startsWith('{')) {
    const target = args[0].startsWith('(') ? null : named(args[0], ctx);
    if (target === null) {
      // A variable program's arguments may still name the runner (`& $node test/tools/run-tests.cjs`).
      const byArgs = args.length > 1 && depth + 1 < MAX_DEPTH ? classifyWords(args, depth + 1, ctx) : null;
      return byArgs?.heavy ? byArgs : unnamed(`& ${args[0]}`);
    }
    return depth + 1 >= MAX_DEPTH ? capped('&') : classifyWords([target, ...args.slice(1)], depth + 1, ctx);
  }
  // A { } script block runs: PowerShell's `Start-Job { npm test }`, `Invoke-Command -ScriptBlock {...}`,
  // `... | ForEach-Object { npm test }`, `& { ... }`, and sh's group `{ npm test; }`.
  const block = ws[0].startsWith('{') ? scriptBlock(ws) : PS_BLOCK_BIN.test(bin) ? scriptBlock(args) : null;
  if (block !== null) return block ? nested(block, depth, ctx, `${bin} { }`) : { heavy: false };
  // A script run directly (`./suite.sh`, `scripts/gate.sh`; HEAVY-LOCK-SHAPES-189: `./x.ps1`).
  if (/\.(sh|bash|ps1)$/i.test(ws[0])) return classifyScript(ws[0], depth, ctx);
  // HEAVY-LOCK-LIVE-FILE-192 (b): a JS file run directly (`& $p K3` with `$p = '...\mut.cjs'`, a
  // shebang `./mut.cjs`) runs under node: node's script rules decide.
  if (/\.[cm]?js$/i.test(ws[0]) && depth + 1 < MAX_DEPTH) return classifyWords(['node', ...ws], depth + 1, ctx);
  // HEAVY-LOCK-SHAPES-189: `source x.sh` / `. x.sh` run the script in this shell.
  if ((bin === 'source' || ws[0] === '.') && args[0]) return classifyScript(args[0], depth, ctx);
  // HEAVY-LOCK-SHAPES-189: a batch file (`cmd /c x.bat`, `call x.cmd`, `x.bat`) runs its text as cmd.
  if (bin === 'call' && args.length) return classifyWords(args, depth, ctx);
  if (/\.(bat|cmd)$/i.test(ws[0]) && !/^(npm|npx|pnpm|yarn|node|electron|electron-builder|electron-rebuild|electron-vite|node-gyp|vitest|tsx|ts-node)$/.test(bin)) {
    return classifyScript(ws[0], depth, ctx, 'cmd');
  }
  // HEAVY-LOCK-SHAPES-189: an extensionless script run by its path (`./run`, `scripts/gate`): its
  // shebang decides. Only a ./ or ../ path that does not read is unknown (heavy, provisional); another
  // unreadable path (`/usr/bin/env`, a Windows tool) is a program the lock cannot see into: light.
  // Its name is judged first (`./node_modules/.bin/vitest` is the suite by name, whatever its shim reads).
  if (/[\\/]/.test(ws[0]) && !ws[0].replace(/\\/g, '/').split('/').pop()!.includes('.')) {
    const named = classifyWords([bin, ...args], depth, ctx);
    if (named.heavy) return named;
    const c = classifyScript(ws[0], depth, ctx);
    return c.provisional && !/^\.{1,2}[\\/]/.test(ws[0]) ? { heavy: false } : c;
  }
  const has = (...xs: string[]): boolean => xs.some((x) => args.includes(x));
  if (bin === 'npm' || bin === 'pnpm' || bin === 'yarn') {
    const sub = args.find((a) => !a.startsWith('-')) ?? (bin === 'yarn' ? 'install' : '');
    if (sub === 'ci' || sub === 'rebuild') return { heavy: true, kind: 'install', why: `${bin} ${sub}` };
    if (sub === 'install' || sub === 'i' || sub === 'add') {
      // `npm install` with no package = a full install; with packages it is still an install
      return { heavy: true, kind: 'install', why: `${bin} ${sub}` };
    }
    // Jim MF2: a test run with a FILTER after `--` (npm run test:focused -- wake) is a focused run:
    // light. Without one it is the suite: heavy.
    const filtered = args.includes('--') && args.indexOf('--') < args.length - 1;
    if (sub === 'test' || sub === 't') return filtered ? { heavy: false } : { heavy: true, kind: 'suite', why: `${bin} test` };
    if (sub === 'run' || sub === 'run-script') {
      const script = args.slice(args.indexOf(sub) + 1).find((a) => !a.startsWith('-')) ?? '';
      if (/^(build|dist)(:.*)?$/.test(script)) return { heavy: true, kind: 'build', why: `${bin} run ${script}` };
      if (/^test(:.*)?$/.test(script)) return filtered ? { heavy: false } : { heavy: true, kind: 'suite', why: `${bin} run ${script}` };
    }
    return { heavy: false };
  }
  // npx's own options; one that takes a value drops it too (`npx --prefix ../wt asar ...` runs asar,
  // not `../wt`, which the extensionless-path rule then read as an unknown program).
  if (bin === 'npx') return classifyWords(args.filter((a, i) => !a.startsWith('-') && !/^(--prefix|--cache|--userconfig|-p|--package|-w|--workspace)$/.test(args[i - 1] ?? '')), depth, ctx);
  if (bin === 'electron-rebuild' || bin === 'node-gyp') return { heavy: true, kind: 'install', why: bin };
  if (bin === 'electron-builder') return { heavy: true, kind: 'build', why: bin };
  if (bin === 'electron-vite' && has('build')) return { heavy: true, kind: 'build', why: 'electron-vite build' };
  if (bin === 'vitest') {
    const files = args.filter((a) => !a.startsWith('-') && a !== 'run');
    if (!files.length) return { heavy: true, kind: 'suite', why: 'vitest (all)' };
    return { heavy: false };
  }
  // The app's exe run as Node (ELECTRON_RUN_AS_NODE): Guppy.exe from 1.1.82, Munder Difflin.exe before.
  // tsx and ts-node run a script as node does (HEAVY-LOCK-ADHOC-NODE).
  if (bin === 'node' || bin === 'electron' || bin === 'guppy' || bin === 'munder difflin' || bin === 'tsx' || bin === 'ts-node') {
    if (args.some((a) => a.startsWith('--native-memory-bench'))) return { heavy: true, kind: 'bench', why: 'native-memory bench' };
    // HEAVY-LOCK-SHAPES-189: `node --check x` (or -c) only parses x: nothing runs.
    if (bin === 'node' && args.some((a) => a === '--check' || a === '-c')) return { heavy: false };
    for (const p of nodePreloads(args)) {
      const base = p.replace(/\\/g, '/').split('/').pop();
      if (SUITE_RUNNER.test(p)) return { heavy: true, kind: 'suite', why: `node -r ${base} (a suite runner preloaded)` };
      if (BENCH_SCRIPT.test(p)) return { heavy: true, kind: 'bench', why: `node -r ${base} (a bench preloaded)` };
    }
    if (args.includes('--test')) {
      // Positional args only: the value of a flag that takes one is not a test file.
      const files: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a.startsWith('-')) { if (NODE_VALUE_FLAGS.has(a)) i++; continue; }
        // HEAVY-LOCK-FALSE-HEAVY-198 (Andy, 2026-10-19 20:21Z): `f=<one file> && node --test $f` was
        // "a glob or a directory" (the word `$f` is not a .js name). A variable the command set to a
        // literal is that literal; one it did not set stays as written (still heavy: fails closed).
        // Jim SHOULD (be555f99): a value splits on whitespace as the shell splits an unquoted `$F`, so
        // `F="a b" && node --test $F` is two files (counted, each read), not one word naming the last.
        const e = ctx.expand ? ctx.expand(a) : a;
        if (e === a) files.push(a); else files.push(...e.split(/\s+/).filter(Boolean));
      }
      if (!files.length) return { heavy: true, kind: 'suite', why: 'node --test (all)' };
      if (files.some((f) => /[*?]/.test(f))) return { heavy: true, kind: 'suite', why: 'node --test (a glob or a directory)' };
      if (files.length >= SUITE_MANY_FILES) return { heavy: true, kind: 'suite', why: `node --test (${files.length} files)` };
      // HEAVY-LOCK-LIVE-FILE-192 (b): a test file named through a variable is the file it names (the
      // words are expanded above); one still computed (`node --test test/$f.test.cjs` with no `f=`,
      // `$(...)`) is unknown: heavy, provisional. A short literal loop wrote its value in (B).
      const paths: string[] = [];
      for (const f of files) {
        if (COMPUTED.test(f)) return unnamed(`node --test ${f}`);
        paths.push(f);
      }
      if (paths.some((f) => /[*?]/.test(f) || !/\.[cm]?[jt]s$/.test(f))) return { heavy: true, kind: 'suite', why: 'node --test (a glob or a directory)' };
      const perf = paths.find((p) => PERF_FILE.test(p));
      if (perf) return { heavy: true, kind: 'bench', why: `node --test ${perf.replace(/\\/g, '/').split('/').pop()} (a wall-clock perf gate)` };
      // HEAVY-LOCK-SHAPES-189: a named test file the lock cannot read (made later in the call) is
      // unknown, as an unreadable script is: heavy, provisional. LIVE-FILE-192 (B, god 66dee2): one
      // iteration of a short literal loop (GLOB-LOOP-196 planned it, its word written in) keeps the
      // replay's reading for a file it cannot read: a loop of single files, light. A loop whose list is
      // not literal never gets here (loopPlan makes it a suite), and a name still computed is unnamed().
      if (ctx.readScript) {
        const readable: string[] = [];
        for (const f of paths) {
          let t: string | null = null;
          try { t = ctx.readScript(f, ctx.cd); } catch { t = null; }
          if (t !== null) readable.push(f);
          else if (!ctx.loopWord) return unreadable(f, ctx);
        }
        // HEAVY-LOCK-LIVE-FILE-192 (a): a test file is judged by what it loads, as `node x.cjs` is (the
        // Electron harness, the embedder, a suite runner), or by its own `@heavy-lock live` line. A
        // single LIVE file (40 s of real helpers and holds) read as light. Every readable file is read,
        // in a loop too (B): each value's file, so a loop over live files is heavy by their tags.
        const c = classifyNodeCode({ script: null, preloads: readable, inline: null, stdin: false }, { ...ctx, stdin: undefined }, false, readable.length + HEAVY_JS_MAX_FILES);
        if (c.heavy) return c;
      }
      return { heavy: false };
    }
    // HEAVY-LOCK-PRELOAD-ESCAPE: the script is the first POSITIONAL argument, as nodeProgram reads
    // it; the value of `--require x` / `-r x` / `--import x` is not the script (it made
    // `node --require x test/tools/run-tests.cjs` light). `-e` code has no script.
    const at = nodeScriptIndex(args);
    // HEAVY-LOCK-LIVE-FILE-192 (b): a script named through a variable (`S=.../mutants-pa.cjs; node
    // "$S" K3`) is judged by the path it names: its name and its text. One the lock cannot name is
    // unknown: heavy, provisional.
    const script0 = at >= 0 ? args[at] : undefined;
    const script = script0 === undefined ? undefined : named(script0, ctx) ?? undefined;
    if (script0 !== undefined && script === undefined) return unnamed(`${bin} ${script0}`);
    if (script !== undefined && script !== script0) args[at] = script;
    if (script && BENCH_SCRIPT.test(script)) return { heavy: true, kind: 'bench', why: `node ${script.replace(/\\/g, '/').split('/').pop()}` };
    // Jim MF2: a whole-suite runner script with no filter argument is the suite.
    if (script && SUITE_RUNNER.test(script)) {
      const rest = args.slice(at + 1).filter((a) => !a.startsWith('-'));
      if (!rest.length) return { heavy: true, kind: 'suite', why: `node ${script.replace(/\\/g, '/').split('/').pop()} (no filter)` };
    }
    // HEAVY-JOB-LOCK-FAILOPEN (Andy 42b671): a wrapper SCRIPT that runs the command after it
    // (`node clean-run.cjs node test/tools/run-tests.cjs`): that command is classified too.
    if (script && depth < 2) {
      const after = args.slice(at + 1);
      const head = after[0]?.replace(/\\/g, '/').split('/').pop()?.toLowerCase().replace(/\.(exe|cmd)$/, '') ?? '';
      if (WRAPPED_BINS.has(head)) return classifyWords(after, depth + 1, ctx);
    }
    // HEAVY-LOCK-ADHOC-NODE: what the script, its preloads, or `-e` / stdin code loads decides, whatever its name.
    return classifyNodeCode(nodeProgram(args), ctx);
  }
  return { heavy: false };
}

/** The inner text of every top-level `$(...)` outside single quotes (each one RUNS its command). */
function substitutions(cmd: string): string[] {
  const out: string[] = [];
  let q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q === "'") { if (c === "'") q = null; continue; }
    if (c === '\\') { i++; continue; }
    if (c === '$' && cmd[i + 1] === '(' && cmd[i + 2] !== '(') { const e = substEnd(cmd, i); out.push(cmd.slice(i + 2, Math.max(i + 2, e - 1))); i = e - 1; continue; }
    if (c === '"') q = q === '"' ? null : '"';
    else if (c === "'" && q === null) q = "'";
  }
  return out;
}

/** Classify a command line: heavy if ANY segment it runs is heavy, a command substitution included. */
export function classifyCommand(cmd: string, depth = 0, ctx: ClassifyCtx = {}): HeavyClass {
  const backtickNode = /^\s*`(?:which|command\s+-v)\s+node`\s+(.+)\s*$/s.exec(cmd);
  if (backtickNode) return classifyCommand(`node ${backtickNode[1]}`, depth, ctx);
  const bodies: string[] = [];
  const d: ShellDialect = ctx.dialect ?? 'sh';
  const text = d === 'cmd' ? cmd : stripHeredocs(cmd, bodies);   // cmd has no heredocs
  // HEAVY-LOCK-BG-LAPSE-189: a file an earlier segment writes from a heredoc (`cat > run.sh <<'EOF'`,
  // `cat <<EOF >> f`, `tee f <<EOF`) is read from that body, so a script made and run in one call is
  // classified by its text, not as unreadable. Only when every heredoc operator of the segments pairs
  // with a body stripHeredocs found (the two scans agree); otherwise nothing is virtual (fail closed).
  const segs = segments(text, d);
  const ops = segs.map((g) => words(g.replace(/\s&$/, ''), d).filter((w) => HEREDOC_OP.test(w)).length);
  const plan: Array<{ seg: string; op: number; looped?: boolean }> | HeavyClass = d === 'cmd' ? segs.map((seg, si) => ({ seg, op: ops[si] })) : loopPlan(segs, ops, d);
  if (!Array.isArray(plan)) return plan;
  // A null entry: a heredoc-made file that a later segment rewrote by other means (cp, mv, sed -i,
  // a `>` that is not a heredoc's), so its text at run time is unknown and it reads as unreadable
  // (S1). A file on disk edited that way is still read as it is now (HEAVY-LOCK-SHAPES-189).
  const virtual = new Map<string, string | null>();
  /** Every file a segment so far rewrote by other means (an append to one of them is unknown too). */
  const rewritten = new Set<string>();
  const paired = d !== 'cmd' && ops.reduce((a, b) => a + b, 0) === bodies.length;
  const vkey = (p: string, cd?: string): string => {
    const raw = p.replace(/^["']|["']$/g, '');
    const abs = /^([A-Za-z]:[\\/]|[\\/]|~)/.test(raw) || !cd ? raw : `${cd.replace(/[\\/]+$/, '')}/${raw}`;
    return normPath(abs).replace(/^\/([A-Za-z])\//, '$1:/').toLowerCase();
  };
  // HEAVY-LOCK-BG-LAPSE-189: the floor's `S=/c/.../scratchpad; cd $S; node run.cjs`: a variable a plain
  // assignment segment of this command set to a literal is substituted before a path is read (the
  // reader refuses a `$` path, which would otherwise make every such script unreadable).
  const vars = new Map<string, string>();
  // HEAVY-LOCK-SHAPES-189 (N-d): a variable this command did not set falls back to the spawn env the
  // caller passed (`$TEMP`, `${HOME}`, PowerShell's `$env:TEMP`), and a leading `~` to its HOME.
  const env = ctx.env ?? {};
  const envGet = (n: string): string | undefined => env[n] ?? env[Object.keys(env).find((k) => k.toLowerCase() === n.toLowerCase()) ?? ''];
  // HEAVY-LOCK-LIVE-FILE-192: a substitution or `bash -c` body sees the variables of the command that
  // runs it (`J=/x; for f in a b; do echo $(node $J/ok.cjs); done`).
  const outer = ctx.expand;
  const expand = (v: string): string => {
    const s0 = expand1(v);
    return outer && COMPUTED.test(s0) ? outer(s0) : s0;
  };
  const expand1 = (v: string): string => {
    const s = v.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)|\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, p: string | undefined, n: string | undefined) =>
      p ? envGet(p) ?? m : vars.get(n!) ?? env[n!] ?? m);
    return env.HOME && /^~(?=[\\/]|$)/.test(s) ? `${env.HOME.replace(/[\\/]+$/, '')}${s.slice(1)}` : s;
  };
  const key = (p: string, cd?: string): string => vkey(expand(p), cd === undefined ? cd : expand(cd));
  const base = ctx.readScript;
  const readScript = base ? (p: string, cd?: string): string | null => {
    const k = key(p, cd);
    return virtual.has(k) ? virtual.get(k)! : base(expand(p), cd === undefined ? cd : expand(cd));
  } : undefined;
  // A file this command writes (a heredoc's target, even one rewritten since) is not "no such file".
  const where = ctx.missingAt;
  const missingAt = where ? (p: string, cd?: string): string | null => virtual.has(key(p, cd)) ? null : where(expand(p), cd === undefined ? cd : expand(cd)) : undefined;
  // Carry the resolved default dialect too: wrapper classification needs to know that a cmd
  // body was supplied by an outer sh command, even when callers did not spell `dialect: 'sh'`.
  let here: ClassifyCtx = { ...ctx, dialect: d, stdin: undefined, expand, ...(readScript ? { readScript } : {}), ...(missingAt ? { missingAt } : {}) };
  let body = 0;
  let maybe: HeavyClass | null = null;
  let cursor = 0;
  for (const { seg, op, looped } of plan) {
    const mine = paired ? bodies.slice(body, body + op) : [];
    body += op;
    // HEAVY-LOCK-CMD-FOR-198: a cmd FOR runs its body (to the end of the line, `&`/`|` included, or to
    // its block's `)`), so the loop is classified from where it starts in the text, not by segment.
    const own = seg.replace(/\s+&$/, '');   // segments() marks a lone `&` (background) with ` &`
    const segAt = d === 'cmd' ? text.indexOf(own, cursor) : -1;
    if (segAt >= 0) cursor = segAt + own.length;
    // HEAVY-LOCK-CMD-FOR-FOLLOWUPS-198: an IF runs its body the same way (the condition is not the program).
    const head = segAt >= 0 ? words(seg, d)[0] ?? '' : '';
    if (/^@?(?:for|if)$/i.test(head)) {
      const loop = /^@?for$/i.test(head) ? cmdFor(text.slice(segAt), depth, here) : cmdIf(text.slice(segAt), depth, here);
      if (loop) {
        if (loop.cls.heavy && !loop.cls.provisional) return loop.cls;
        if (loop.cls.heavy && !maybe) maybe = loop.cls;
        if (loop.rest.trim()) {
          const c = classifyCommand(loop.rest, depth, here);   // a shorter text: no depth to spend
          if (c.heavy && !c.provisional) return c;
          if (c.heavy && !maybe) maybe = c;
        }
        break;
      }
    }
    // HEAVY-JOB-LOCK-FAILOPEN: a substitution is opaque to the segment split (its pipes are its own),
    // but it RUNS: `X="$(node test/tools/run-tests.cjs)"` is a suite. B1: classified where it runs,
    // with this point's cd and variables (`J=/x; X="$(bash $J/light.sh)"` reads /x/light.sh).
    if (depth < 3) {
      for (const inner of substitutions(seg)) {
        const c = classifyCommand(inner, depth + 1, here);
        if (c.heavy && !c.provisional) return c;
        if (c.heavy && !maybe) maybe = c;
      }
    }
    // The raw doubled-quote cmd form is opaque to the shell-word tokenizer: classify its
    // inner executable before tokenizing, but do so per segment so later chained commands
    // are still inspected independently.
    const doubledCmd = /^\s*(?:[a-z]:\\.*\\)?cmd(?:\.exe)?\s+(?:\/d\s+)?(?:\/s\s+)?\/c\s+""(.+?\.(?:exe|cmd))"\s*(.*?)"\s*$/i.exec(seg);
    if (doubledCmd) {
      const inner = classifyCommand(`"${doubledCmd[1]}" ${doubledCmd[2]}`, depth + 1, { ...ctx, dialect: 'cmd' });
      if (inner.heavy) return inner;
      continue;
    }
    const raw = words(seg.replace(/\s&$/, ''), d);
    // HEAVY-LOCK-SHELL-KEYWORD-196: `do npm ci`, `then npm test`: a keyword is not the program.
    const ws = stripKeywords(stripRedirects(raw), d);
    // HEAVY-LOCK-ADHOC-NODE: what this segment reads on stdin (a heredoc body, a `< file`).
    let stdin: string | null | undefined;
    for (let i = 0; i < raw.length; i++) {
      if (/^\d*<<-?(?!<)/.test(raw[i])) { stdin = bodies.join('\n'); break; }
      const m = /^0?<(?![<&>])(.*)$/.exec(raw[i]);
      if (m) {
        const f = m[1] || raw[i + 1] || '';
        try { stdin = here.readScript && f ? here.readScript(f, here.cd) : null; } catch { stdin = null; }
        break;
      }
    }
    const assigns = ws[0] === 'export' ? ws.slice(1) : ws;
    if (assigns.length && assigns.every((w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w))) {
      for (const w of assigns) {
        // A computed value (`$(mktemp -d)`) is kept as written: a path through it never reads (the
        // reader refuses `$`), so it stays unreadable, yet still names the same heredoc-written file.
        const at = w.indexOf('=');
        vars.set(w.slice(0, at), expand(w.slice(at + 1).replace(/^["']|["']$/g, '')));
      }
    }
    // HEAVY-LOCK-LIVE-FILE-192 (b): PowerShell's `$p = 'C:\x\mut.cjs'` (or `$p='...'`) sets $p for a
    // later `node $p` / `& $p`. Only a literal: anything computed stays unset (unknown, fail closed).
    const psSet = ws.length === 1 ? /^\$([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(ws[0])
      : ws.length === 3 && ws[1] === '=' ? /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(ws[0]) : null;
    if (psSet) {
      const v = (ws.length === 1 ? psSet[2] : ws[2]).replace(/^["']|["']$/g, '');
      if (!/[$`(@[]/.test(v)) vars.set(psSet[1], v);
    }
    // HEAVY-LOCK-SCRIPT-WRAPPER: `cd X && bash suite.sh` reads X/suite.sh.
    if ((ws[0] === 'cd' || ws[0] === 'pushd') && ws[1] && !ws[1].startsWith('-')) {
      const to = expand(ws[1]);   // B1: `cd X; S=/abs; cd $S` moves to /abs, not X/$S
      here = { ...here, cd: /^([A-Za-z]:[\\/]|[\\/]|~)/.test(to) || !here.cd ? to : `${here.cd.replace(/[\\/]+$/, '')}/${to}` };
      continue;
    }
    // Jim n2: `cat <<'EOF' | node -`: the heredoc of an earlier segment is what the pipe feeds `-`.
    if (stdin === undefined && bodies.length && raw.includes('-')) stdin = bodies.join('\n');
    const at = looped ? { ...here, loopWord: true } : here;
    const c = classifyWords(ws, depth, { ...(stdin === undefined ? at : { ...at, stdin }), expandKnown: expand, segment: seg });
    if (c.heavy && !c.provisional) return c;
    if (c.heavy && !maybe) maybe = c;
    const wrote = mine.length === 1 ? heredocWrite(raw, ws, mine[0], here, virtual, key, rewritten) : new Set<string>();
    for (const f of writeTargets(raw, ws)) {
      const k = key(f, here.cd);
      if (wrote.has(k)) continue;
      rewritten.add(k);
      if (virtual.has(k)) virtual.set(k, null);
    }
  }
  return maybe ?? { heavy: false };
}

const HEREDOC_OP = /^\d*<<-?(?!<)/;

/** A case arm's pattern (`a)`, `a|b)` after the pipe split, `*)`, `(a)`); not a `$(...)` word. */
const CASE_ARM = /^\(?[^()$`'"]*\)$/;
/** A function definition's head: `f()` as one word, or `f` then `()`. */
const FUNC_HEAD = /^[A-Za-z_][\w.:-]*\(\)$/;
/**
 * HEAVY-LOCK-SHELL-KEYWORD-196: drop what opens a segment before its program: the shell keywords.
 * HEAVY-LOCK-GLOB-LOOP-196 (Jim 9a7378, god 531e28): also a `case WORD in` head, a case arm's
 * pattern (`case x in a) npm test;; esac`) and a function head (`function f {`, `f() {`), so a
 * function body is classified where it is defined, called or not (fails closed).
 */
function stripKeywords(ws: string[], d: ShellDialect): string[] {
  if (d === 'cmd') return ws;
  let i = 0;
  while (i < ws.length) {
    // HEAVY-LOCK-LOOP-BODY-198 (Jim e33e76): a case arm is followed by its command; a last word that
    // looks like one is a subshell's (`(./suite.sh)`, `( cd . && ./suite.sh)`), so it stays a word.
    if (i === ws.length - 1 && CASE_ARM.test(ws[i])) break;
    if (SHELL_KEYWORDS.has(ws[i]) || CASE_ARM.test(ws[i]) || FUNC_HEAD.test(ws[i])) i++;
    else if (ws[i] === 'case' && ws[i + 2] === 'in') i += 3;
    else if (ws[i] === 'function' && ws[i + 1]) i += 2;
    else if (ws[i + 1] === '()' && /^[A-Za-z_][\w.:-]*$/.test(ws[i])) i += 2;
    else break;
  }
  let out = i ? ws.slice(i) : ws;
  // `(cd test; npm test)`, `(npm run build)`: a subshell's `(` and `)` are glued to the first and
  // last words (Jim 2e2f8a). HEAVY-LOCK-LOOP-BODY-198 (subshells): nested ones glue several,
  // `((cd x && npm test) )`, `(cd x && (npm test))`, and a `)` may stand alone after the last word.
  // A one-word segment too: `(./suite.sh)`, `((./suite.sh))` (Jim e33e76).
  if (out.length && /^\(+[^()'"$`]+\)*$/.test(out[0])) out = [out[0].replace(/^\(+/, ''), ...out.slice(1)];
  while (out.length > 1 && out[out.length - 1] === ')') out = out.slice(0, -1);
  const last = out[out.length - 1];
  return out.length && /^[^()'"$`]+\)+$/.test(last) ? [...out.slice(0, -1), last.replace(/\)+$/, '')] : out;
}

/**
 * HEAVY-LOCK-GLOB-LOOP-196: a `for VAR in WORDS` loop whose body runs `node --test` on $VAR.
 * - WORDS a glob, computed (`$(...)`, `$files`) or SUITE_MANY_FILES or more: the loop is a serial
 *   run over the suite: a suite (god 0f986b), whatever each iteration is alone.
 * - a short explicit list: a body that uses $VAR is classified once per word, with $VAR replaced by
 *   it (so a per-file loop over named files stays light, as each of its runs would be alone).
 * - nested loops: a body is planned with `mult`, the product of the enclosing short lists' lengths,
 *   so 10 x 10 words count as 100 runs (Jim 9a7378). A glob or computed list is unbounded: its body
 *   is a suite once it runs node --test, an inner loop's runs included (Jim 2e2f8a).
 * - the runs are words x mult x the body's node --test segments, whether or not they use $VAR, so a
 *   repeat loop (`for i in $(seq 50); do node --test a.test.cjs`) is a suite too (Jim 2e2f8a).
 * - the plan is capped at PLAN_CAP segments: past it a body is planned once, not per word, so
 *   a deep nest of long lists costs a fixed time on the main thread (Jim 2e2f8a MUST).
 * - while/until loops are not counted (unbounded, but rare as an agent shape): each segment is
 *   classified as it stands.
 * Returns the segments to classify (a body is repeated per word; one with a heredoc is kept as is),
 * or the suite class.
 */
const PLAN_CAP = 2000;
const NODE_TEST = (s: string): boolean => /(^|[\s("'/\\])node(\.exe)?["']?\s/.test(s) && /\s--test\b/.test(s);
function loopPlan(segs: string[], ops: number[], d: ShellDialect, mult = 1): Array<{ seg: string; op: number; looped?: boolean }> | HeavyClass {
  const out: Array<{ seg: string; op: number; looped?: boolean }> = [];
  for (let si = 0; si < segs.length; si++) {
    out.push({ seg: segs[si], op: ops[si] });
    const head = stripKeywords(words(segs[si].replace(/\s&$/, ''), d), d);
    if (head[0] !== 'for' || head[2] !== 'in' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(head[1] ?? '')) continue;
    // The body: up to the `done` that closes this loop (nested loops counted).
    let depth = 1; let end = si + 1;
    for (; end < segs.length; end++) {
      const w = words(segs[end].replace(/\s&$/, ''), d);
      const opener = w.find((x) => !['do', 'then', 'else', 'elif', '!', '{'].includes(x));
      if (opener === 'for' || opener === 'while' || opener === 'until') depth++;
      if (w[0] === 'done' && --depth === 0) break;
    }
    const name = head[1];
    const list = head.slice(3);
    const body = segs.slice(si + 1, end);
    const at = `\\$(?:\\{${name}\\}|${name}(?![A-Za-z0-9_]))`;   // `${f}x` is $f then x
    const ref = new RegExp(at, 'g');
    const tests = body.filter(NODE_TEST).length;
    const open = list.some((w) => /[*?[$`]/.test(w));   // a glob or a computed list: unbounded
    const runs = open ? Infinity : list.length * mult;
    // The hint only where writing the names out helps: this list is the glob or computed one and the
    // body runs on $VAR (a repeat loop such as `for i in $(seq 50)` stays a suite written out; Jim 050139).
    const uses = body.some((s) => new RegExp(at).test(s));
    const hint = uses && open ? ' (write the file names out to run it light)' : '';
    const big = runs === Infinity ? `a glob or a computed list${hint}`
      : runs * tests >= SUITE_MANY_FILES ? `${runs * tests} runs${mult > 1 ? ' (nested lists)' : ''}` : null;
    if (tests && big) return { heavy: true, kind: 'suite', why: `a loop of node --test over ${big}` };
    if (!list.length) continue;
    const inner = loopPlan(body, ops.slice(si + 1, end), d, runs);
    if (!Array.isArray(inner)) return inner;
    // LIVE-FILE-192 (B): an outer `$a` right before this word is braced first, so `$a$b` with b=x is
    // `${a}x` (the shell's reading), not a new name `$ax` the outer loop never writes in.
    const glued = new RegExp(`\\$([A-Za-z_][A-Za-z0-9_]*)(?=${at})`, 'g');
    if (!uses || body.some((_, k) => ops[si + 1 + k] > 0) || out.length + list.length * inner.length > PLAN_CAP) out.push(...inner);
    else for (const w of list) for (const p of inner) out.push({ seg: p.seg.replace(glued, '$${$1}').replace(ref, () => w), op: 0, looped: true });
    si = end - 1;   // the body is planned; `done` (if any) comes next
  }
  return out;
}

/** The number of segments loopPlan plans for `cmd` (sh), or -1 when it settles the command itself (exported for tests). */
export function planSize(cmd: string): number {
  const segs = segments(stripHeredocs(cmd, []), 'sh');
  const plan = loopPlan(segs, segs.map(() => 0), 'sh');
  return Array.isArray(plan) ? plan.length : -1;
}
export { PLAN_CAP };

/**
 * HEAVY-LOCK-CMD-FOR-198 (Jim 74a22b): cmd's `for [/d | /r [dir] | /l | /f ["opts"]] %v in (set) do
 * body` (`%%v` in a .bat/.cmd), planned as loopPlan plans a bash for:
 * - the body is everything after `do` to the end of the line, `&`, `&&`, `|`, `||` included (cmd runs
 *   them all per iteration), or, after `do (`, the block up to its `)` (lines included); what follows
 *   the block (`) & echo done`, the next lines of a script) is the `rest`, classified as it stands;
 * - the set is OPEN (a glob, a /r walk, a /f read, a `%VAR%` or `!VAR!`) or a count: an explicit list
 *   (its length) or a /l range ((end - start) / step + 1); nested loops multiply (ctx.loopMult);
 * - a body that runs node --test is a suite over an open set or SUITE_MANY_FILES runs, as in sh;
 * - otherwise the body is classified once per value with %v (and %~nv-style refs) replaced, as one
 *   iteration of a loop (loopWord); an open set, a /l range or more than PLAN_CAP runs once as written;
 * - a /f set's `'command'` (`` `command` `` with usebackq) RUNS: it is classified too.
 * Returns null when the text does not open a FOR this reads (cmd itself would refuse it).
 */
const CMD_FOR = /^@?for\s+((?:\/[dlrf](?:\s+(?!%)(?:"[^"]*"|[^\s"%/]\S*))?\s+)*)(%%?)([A-Za-z])\s+in\s*\(/i;
/**
 * HEAVY-LOCK-CMD-FOR-FOLLOWUPS-198: cmd joins a line that ends in an unescaped `^` to the next one.
 * HEAVY-LOCK-CMD-QUOTED-CARET-198: only outside a quote. Inside a `"` opened on its line a `^` is
 * literal, and the quote ends with the line (segments() then separates there).
 */
function caretJoin(s: string): string {
  let out = ''; let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\n') { q = false; out += c; continue; }
    if (c === '"') q = !q;
    if (c === '^' && !q) {
      const nl = s[i + 1] === '\r' && s[i + 2] === '\n' ? 2 : s[i + 1] === '\n' ? 1 : 0;
      if (nl) { i += nl; continue; }
      out += c + (s[i + 1] ?? ''); i++; continue;
    }
    out += c;
  }
  return out;
}
/** A cmd block from its `(`: the text inside, and what follows its own `)` (quotes, `^` and nesting respected). */
function cmdBlock(s: string): { body: string; after: string } {
  let k = 1; let n = 1; let q: string | null = null;
  for (; k < s.length; k++) {
    const c = s[k];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"') { q = c; continue; }
    if (c === '^') { k++; continue; }
    if (c === '(') n++;
    if (c === ')' && --n === 0) break;
  }
  return { body: s.slice(1, k), after: s.slice(k + 1).replace(/^[ \t]*(?:&&?|\|\|?)/, '') };
}
/** A bare cmd body runs to the end of its line; the lines after it are the rest. */
function cmdLine(s: string): { body: string; after: string } {
  const nl = s.indexOf('\n');
  return nl >= 0 ? { body: s.slice(0, nl), after: s.slice(nl + 1) } : { body: s, after: '' };
}
/**
 * HEAVY-LOCK-CMD-FOR-FOLLOWUPS-198: cmd's `if [/i] [not] <condition> body [else body]`. The condition
 * (errorlevel N, exist f, defined v, a==b, a EQU b, ...) runs nothing; either body may run, so each is
 * classified, a bare one to the end of its line (an `else` there is just words) and a block to its `)`.
 * Returns null when the text does not open an IF this reads.
 */
const CMD_IF = /^@?if\s+(?:\/i\s+)?(?:not\s+)?(?:(?:errorlevel|cmdextversion)\s+\S+|(?:exist|defined)\s+(?:"[^"]*"|\S+)|(?:"[^"]*"|[^\s=]+)\s*==\s*(?:"[^"]*"|[^\s=]+)|(?:"[^"]*"|\S+)\s+(?:equ|neq|lss|leq|gtr|geq)\s+(?:"[^"]*"|\S+))\s+/i;
function cmdIf(text: string, depth: number, ctx: ClassifyCtx): { cls: HeavyClass; rest: string } | null {
  const src = caretJoin(text.trimStart());
  const m = CMD_IF.exec(src);
  if (!m) return null;
  const s = src.slice(m[0].length);
  const then = s.startsWith('(') ? cmdBlock(s) : cmdLine(s);
  const bodies = [then.body];
  let rest = then.after;
  const e = s.startsWith('(') ? /^\s*else\s+/i.exec(then.after) : null;
  if (e) {
    const t = then.after.slice(e[0].length);
    const other = t.startsWith('(') ? cmdBlock(t) : cmdLine(t);
    bodies.push(other.body);
    rest = other.after;
  }
  const here: ClassifyCtx = { ...ctx, dialect: 'cmd' };
  let maybe: HeavyClass | null = null;
  for (const b of bodies) {
    const c = classifyCommand(b, depth, here);
    if (c.heavy && !c.provisional) return { cls: c, rest };
    if (c.heavy && !maybe) maybe = c;
  }
  return { cls: maybe ?? { heavy: false }, rest };
}
function cmdFor(text: string, depth: number, ctx: ClassifyCtx): { cls: HeavyClass; rest: string } | null {
  const src = caretJoin(text.trimStart());
  const m = CMD_FOR.exec(src);
  if (!m) return null;
  const opts = m[1].toLowerCase();
  const f = /\/f/.test(opts); const l = /\/l/.test(opts); const r = /\/r/.test(opts);
  // The set, to its `)`; a /f set's quotes hold their own parentheses.
  let i = m[0].length; let q: string | null = null;
  const quotes = f ? `"'\`` : '"';
  for (; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === q) q = null; continue; }
    if (quotes.includes(c)) { q = c; continue; }
    if (c === ')') break;
  }
  if (i >= src.length) return null;
  const set = src.slice(m[0].length, i).trim();
  const doAt = /^\s*do\s+/i.exec(src.slice(i + 1));
  if (!doAt) return null;
  const tail = src.slice(i + 1 + doAt[0].length);
  const { body, after: rest } = tail.startsWith('(') ? cmdBlock(tail) : cmdLine(tail);
  const here: ClassifyCtx = { ...ctx, dialect: 'cmd' };
  let maybe: HeavyClass | null = null;
  // A /f set's command runs once, before the loop.
  const ran = f ? /^(['`])(.*)\1$/s.exec(set) : null;
  if (ran) {
    const c = classifyCommand(ran[2], depth + 1, here);
    if (c.heavy && !c.provisional) return { cls: c, rest };
    if (c.heavy) maybe = c;
  }
  const values = l || f ? [] : (set.match(/"[^"]*"|[^\s,;=]+/g) ?? []);
  let count = Infinity;
  if (l) {
    const n = set.split(/[\s,;=]+/).filter(Boolean).map(Number);
    if (n.length === 3 && n.every(Number.isFinite) && n[1] !== 0) count = Math.max(0, Math.floor((n[2] - n[0]) / n[1]) + 1);
  } else if (!f && !r && !values.some((v) => /[*?%!]/.test(v))) count = values.length;
  const runs = count * (ctx.loopMult ?? 1);
  const tests = segments(body, 'cmd').filter(NODE_TEST).length;
  if (tests && (runs === Infinity || runs * tests >= SUITE_MANY_FILES)) {
    return { cls: { heavy: true, kind: 'suite', why: `a cmd FOR loop of node --test over ${runs === Infinity ? 'an open set (a glob, /r, /f or a variable)' : `${runs * tests} runs`}` }, rest };
  }
  // FOLLOWUPS-198: a %NAME% variable is not the loop's %n (`%foo%` stays), and %~$PATH:v names v too. A
  // one-letter %a% is the loop's (nested `%a%b` is a then b: the line keeps an undefined %a% for FOR).
  const ref = new RegExp(`(%[A-Za-z_][A-Za-z0-9_]+%)|${m[2]}(?:~[A-Za-z]*(?:\\$[A-Za-z_][A-Za-z0-9_]*:)?)?${m[3]}`, 'g');
  const put = (b: string, v: string): string => b.replace(ref, (x, name?: string) => name ? x : v);
  // A body still holding a %NAME% / !NAME! is not all loop-made: it is read as it would be outside a loop.
  // Any length (Jim 36f8db): the loop's own letter is already replaced by then (nested %a%b reads l%b).
  // But at a prompt cmd expands an environment %f% before the FOR runs (Jim d68c16): the text cannot say
  // whether f is set, so a raw %<loop letter>% (single-% form) is not loop-made either.
  const unmade = /%[A-Za-z_][A-Za-z0-9_]*%|![^!\r\n]+!/;
  const envLetter = m[2] === '%' && body.includes(`%${m[3]}%`);
  const one = (b: string): HeavyClass => classifyCommand(b, depth, { ...here, loopWord: !envLetter && !unmade.test(b), loopMult: runs === Infinity ? runs : Math.max(runs, 1) });
  const each = runs !== Infinity && !l && values.length && runs <= PLAN_CAP
    ? values.map((v) => put(body, v))   // cmd's words drop a value's quotes, so %~f reads as %f
    : [l && runs !== Infinity ? put(body, String(set.split(/[\s,;=]+/).filter(Boolean)[0])) : body];
  for (const b of each) {
    const c = one(b);
    if (c.heavy && !c.provisional) return { cls: c, rest };
    if (c.heavy && !maybe) maybe = c;
  }
  return { cls: maybe ?? { heavy: false }, rest };
}

/** HEAVY-LOCK-BG-LAPSE-189: `cat > f <<EOF` / `cat <<EOF >> f` / `tee [-a] f <<EOF` write the body to f. */
function heredocWrite(raw: string[], ws: string[], body: string, here: ClassifyCtx, virtual: Map<string, string | null>, vkey: (p: string, cd?: string) => string, rewritten: ReadonlySet<string>): Set<string> {
  const bin = (ws[0] ?? '').replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.exe$/, '');
  const text = `${body}\n`;
  const wrote = new Set<string>();
  const put = (f: string, append: boolean): void => {
    const k = vkey(f, here.cd);
    wrote.add(k);
    let old: string | null = null;
    if (append) { try { old = here.readScript ? here.readScript(f, here.cd) : null; } catch { old = null; } }
    // S1: appending to a file rewritten by other means earlier in the command: its text is unknown
    // (the disk still holds the old one), so the result is unknown too.
    if (append && (virtual.get(k) === null || (!virtual.has(k) && rewritten.has(k)))) { virtual.set(k, null); return; }
    virtual.set(k, append ? `${old ?? ''}${text}` : text);
  };
  if (bin === 'cat') {
    if (ws.slice(1).some((a) => a !== '-')) return wrote;   // `cat a.txt > f`: f is not the heredoc
    for (let i = 0; i < raw.length; i++) {
      const m = /^1?(>>?)(?![&>])(.*)$/.exec(raw[i]);
      if (m) { const f = m[2] || raw[i + 1]; if (f) put(f, m[1] === '>>'); }
    }
  } else if (bin === 'tee') {
    const flags = ws.slice(1).filter((a) => a.startsWith('-'));
    for (const f of ws.slice(1).filter((a) => !a.startsWith('-'))) put(f, flags.some((a) => /^-[a-z]*a|^--append$/.test(a)));
  }
  return wrote;
}

/** HEAVY-LOCK-BG-LAPSE-189 S1: the files a segment writes by means other than a heredoc body: a `>` /
 *  `>>` / `&>` / `>|` target, the destination of cp / mv / install (and mv's sources, now gone), the
 *  files of sed -i / perl -i, and tee's files. A heredoc writer's own targets (heredocWrite's
 *  keys) are not poisoned, so `cat > f <<EOF` stays readable. */
function writeTargets(raw: string[], ws: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const m = /^(?:\d*|&)(>\||>>?)(?![&>])(.*)$/.exec(raw[i]);   // `>|` first: else `>` matches and the target reads as "|"
    if (m) { const f = m[2] || raw[i + 1]; if (f && !/^\/dev\//.test(f)) out.push(f); }
  }
  const lead = leading(ws);
  const bin = (lead[0] ?? '').replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.exe$/, '');
  const args = lead.slice(1);
  const pos = args.filter((a) => !a.startsWith('-'));
  if ((bin === 'cp' || bin === 'mv' || bin === 'install') && pos.length >= 2) {
    const dest = pos[pos.length - 1];
    out.push(dest);
    // The destination may be a directory: each source lands under it by its own name.
    for (const s of pos.slice(0, -1)) out.push(`${dest.replace(/[\\/]+$/, '')}/${s.replace(/\\/g, '/').split('/').pop()}`);
    if (bin === 'mv') out.push(...pos.slice(0, -1));
  } else if (bin === 'tee') {
    out.push(...pos);
  } else if ((bin === 'sed' || bin === 'perl') && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) {
    // The program is the first positional unless -e / -f gave it (their value is the next word).
    const files: string[] = [];
    let prog = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-e' || a === '-f' || a === '--expression' || a === '--file') { prog = true; i++; continue; }
      if (a.startsWith('-')) continue;
      files.push(a);
    }
    out.push(...(prog ? files : files.slice(1)));
  } else if (bin === 'curl') {
    // HEAVY-LOCK-SHAPES-189: `curl -o f URL` / `--output f` / `--output=f` / `-of`.
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--output' || /^-[a-zA-Z]*o$/.test(a)) { if (args[i + 1]) out.push(args[++i]); }
      else if (a.startsWith('--output=')) out.push(a.slice(9));
      else if (/^-[a-zA-Z]*o./.test(a) && !a.startsWith('--')) out.push(a.slice(a.indexOf('o') + 1));
    }
  } else if (bin === 'git') {
    // HEAVY-LOCK-SHAPES-189: `git checkout [rev] -- f` and `git restore [--source x] f` rewrite f.
    let k = 0;
    while (k < args.length && args[k].startsWith('-')) k += /^-[Cc]$/.test(args[k]) ? 2 : 1;
    const sub = args[k], rest = args.slice(k + 1);
    if (sub === 'checkout' && rest.includes('--')) out.push(...rest.slice(rest.indexOf('--') + 1));
    else if (sub === 'restore') {
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--source' || rest[i] === '-s') { i++; continue; }
        if (rest[i] !== '--' && !rest[i].startsWith('-')) out.push(rest[i]);
      }
    }
  } else if (bin === 'ln') {
    // HEAVY-LOCK-SHAPES-189: `ln -sf target link` makes link (one operand: a link by its name, here).
    const pos2 = args.filter((a) => !a.startsWith('-'));
    if (pos2.length >= 2) out.push(pos2[pos2.length - 1]);
    else if (pos2.length === 1) out.push(pos2[0].replace(/\\/g, '/').split('/').pop()!);
  } else if (bin === 'dd') {
    for (const a of args) if (a.startsWith('of=')) out.push(a.slice(3));   // HEAVY-LOCK-SHAPES-189
  } else if (bin === 'node') {
    // HEAVY-LOCK-SHAPES-189: `node -e "fs.writeFileSync('f', ...)"`: a literal first argument of a
    // write / append / copy-destination call is a file the program writes.
    const e = args.findIndex((a) => a === '-e' || a === '--eval' || a === '-p' || a === '--print');
    const code = e >= 0 ? args[e + 1] ?? '' : '';
    for (const m of code.matchAll(/\b(?:writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream)\s*\(\s*(['"`])([^'"`$]+)\1/g)) out.push(m[2]);
    for (const m of code.matchAll(/\b(?:copyFileSync|copyFile|renameSync|rename)\s*\(\s*(['"`])[^'"`]*\1\s*,\s*(['"`])([^'"`$]+)\2/g)) out.push(m[3]);
  }
  return out;
}

/** Classify a tool call (any provider: the command-shaped input only). */
/**
 * HEAVY-LOCK-UNNAMED-EXEC (god c8cd07): the shell text a tool call runs. Codex's plain
 * `write_stdin` types `chars` into a running exec session (often a shell): that text, trailing
 * newline trimmed, is its command; an empty or absent `chars` is a poll (nothing runs).
 */
export function heavyCommandOf(toolName: string | undefined, input: unknown): string | null {
  if (toolName === 'write_stdin') {
    const c = input && typeof input === 'object' ? (input as Record<string, unknown>).chars : undefined;
    return typeof c === 'string' ? c.replace(/[\r\n]+$/, '') || null : null;
  }
  return commandFromToolInput(input);
}

export function classifyHeavy(toolName: string | undefined, input: unknown, ctx: ClassifyCtx = {}): HeavyClass {
  const cmd = heavyCommandOf(toolName, input);
  return cmd ? classifyCommand(cmd, 0, ctx) : { heavy: false };
}

/** HEAVY-LOCK-SCRIPT-WRAPPER: the largest script file the classifier reads. */
export const HEAVY_SCRIPT_MAX_BYTES = 256 * 1024;

/** A ClassifyCtx reading scripts relative to `cwd` (the tool call's), size-capped; null on any failure. */
export function scriptReaderFor(cwd: string | null | undefined, read: (absPath: string) => { size: number; text: () => string } | null): ClassifyCtx {
  const resolve = (p: string, cd?: string): string | null => {
    const raw = p.replace(/^["']|["']$/g, '');
    if (!raw || raw.includes('$') || cd?.includes('$') || cd?.startsWith('~')) return null;
    const isAbs = (x: string): boolean => /^([A-Za-z]:[\\/]|[\\/])/.test(x);
    const base = cd ? (isAbs(cd) || !cwd ? cd : `${cwd.replace(/[\\/]+$/, '')}/${cd}`) : cwd;
    return isAbs(raw) || !base ? raw : `${base.replace(/[\\/]+$/, '')}/${raw}`;
  };
  return {
    missingAt: (p: string, cd?: string): string | null => {
      const abs = resolve(p, cd);
      if (abs === null || read(abs)) return null;
      return abs.replace(/\\/g, '/').replace(/^\/([A-Za-z])\//, (_m, d: string) => `${d.toUpperCase()}:/`);
    },
    readScript: (p: string, cd?: string): string | null => {
      const abs = resolve(p, cd);
      if (abs === null) return null;
      const f = read(abs);
      if (!f || f.size > HEAVY_SCRIPT_MAX_BYTES) return null;
      // Jim (HEAVY-LOCK-ADHOC-NODE audit): the read can race the stat (deleted, locked): no throw.
      try { return f.text(); } catch { return null; }
    }
  };
}

/** Does this tool call leave the job running after the call returns? */
export function isBackground(input: unknown): boolean {
  if (input && typeof input === 'object' && (input as Record<string, unknown>).run_in_background === true) return true;
  const cmd = commandFromToolInput(input) ?? '';
  return /(^|[^&])&\s*$/.test(cmd.trim()) || /\bnohup\b|\bStart-Job\b|\bsetsid\b/.test(cmd);
}

// — the lock —

export type HeavyLimit = number | 'off';
/** The Settings value, normalised: 'off', or an integer 1..16 (default 1). */
export function heavyLimit(v: unknown): HeavyLimit {
  if (v === 'off' || v === false || v === 0) return 'off';
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1 ? Math.min(16, n) : 1;
}

export interface HeavyHolder {
  agentId: string;
  kind: HeavyKind;
  command: string;
  since: number;
  /** Last acquire or re-entry: the TTL runs from here. */
  touched: number;
  /** Foreground heavy calls still running (their PostToolUse releases them). */
  calls: Set<string>;
  /** A backgrounded job: released by its processes exiting (the watcher), the PTY, or the TTL. */
  background: boolean;
  /** HEAVY-LOCK-BG-LAPSE-189: the calls held only because a script was unreadable at PreToolUse,
   *  and whether any call of this holder was heavy outright (then none of them is settled early). */
  provisional: Set<string>;
  definite: boolean;
  /** Consecutive watcher scans that found no heavy process of this holder. */
  misses: number;
  /** The last watcher scan saw a heavy process of this holder (for a TTL expiry's log). */
  seenRunning: boolean;
  /** pid -> createdMs of this holder's job processes seen on earlier scans (Jim: orphans stay attributed). */
  attributed: Map<number, number>;
  /** HEAVY-JOB-LOCK-FAILOPEN (b): when each heavy CALL ran (PreToolUse to PostToolUse; end null =
   *  still running). Only processes created inside one of these (or their descendants) are the job:
   *  a later, unrelated call of the same agent (a wait-for-release loop) never holds the slot. */
  windows: Array<{ callId: string; start: number; end: number | null }>;
  /** The last process check for this holder: 'ok', or 'failed' (the listing failed; kept, fail closed). */
  lastProbe: 'ok' | 'failed' | null;
  /** HEAVY-LOCK-RELEASE-LAG-197: the calls whose processes run in jobs Guppy holds (callId -> job id ->
   *  that job has nothing of the call left). Keyed by job as well: a call with no tool_use_id is
   *  'cmd:<command>', so the same command run twice is two windows and two jobs under one callId. When
   *  EVERY window of the holder has its own held job and all have exited, the slot is freed at once; a
   *  window without such a job leaves the holder to the process checks. */
  jobs: Map<string, Map<string, boolean>>;
  /** HEAVY-SLOT-EXCLUSIVE-192: it runs alone (an exclusive re-entry makes it so). */
  exclusive: boolean;
}

/** A process created this long after its call's PostToolUse still belongs to the call (a
 *  backgrounded job's processes start as its call returns). */
export const HEAVY_CALL_SLACK_MS = 3_000;
/**
 * Jim H1: a window is also bounded by its START. A heavy call's job is started by the call itself
 * (its shell, launcher or exec process appears within moments of the PreToolUse), and everything the
 * job spawns later is counted through ancestry. So a window never needs to stay open longer than this
 * after its start, and an UNPAIRED call (a degraded Codex hook: its PostToolUse never reaches
 * callDone) can no longer leave an open-ended window that claims the agent's later processes.
 */
export const HEAVY_CALL_SPAWN_MS = 60_000;
/** HEAVY-LOCK-OPAQUE-SCRIPT-196: the longest a loop call's run matches without its PostToolUse (the Bash tool caps a call at 10 min). */
export const HEAVY_LOOP_CALL_MS = 15 * 60_000;

/** One process of the listing. `createdMs` (epoch ms) is what the watcher judges by (Jim MF3). */
export interface ProcRow { pid: number; parentPid: number; commandLine: string; createdMs?: number }
/** Clock skew allowed between the app's clock and a process CreationDate. */
export const HEAVY_CREATED_SKEW_MS = 2_000;
export interface HeavyLockDeps {
  limit: () => HeavyLimit;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  /** The PTY root pid of each agent (main's pty manager). */
  roots?: () => Array<{ agentId: string; pid: number }>;
  /** A process listing (hidden; only ever called while a slot is held). null = the listing FAILED. */
  probe?: () => Promise<ProcRow[] | null>;
  log?: (row: Record<string, unknown>) => void;
  /** HEAVY-LOCK-SELF-WAIT: tell a queued agent that a slot is RESERVED for it until `until` (ms). */
  notify?: (agentId: string, kind: HeavyKind, until: number) => void;
  /** A limit switched to Off releases every queued/reserved agent without a reservation. */
  notifyUnlimited?: (agentId: string, kind: HeavyKind) => void;
  /** LOCK-WAIT-NOTICES: tell an agent its reservation lapsed unused ('expired'), so it has left the
   *  queue. Not called for the agent whose own heavy call is running, nor for a gone one.
   *  HEAVY-QUEUE-WAIT-DROPS: the lock no longer drops a waiter by age, so it never sends 'stale'
   *  (the value stays for main's notice function). */
  notifyLapse?: (agentId: string, kind: HeavyKind, why: 'stale' | 'expired') => void;
  /** Is this agent still live (a PTY)? A gone waiter is reaped: skipped at a grant and swept at
   *  every watcher tick (HEAVY-QUEUE-WAIT-DROPS: by liveness, never by age). Absent = every agent is live. */
  alive?: (agentId: string) => boolean;
  /** HEAVY-LOCK-OPAQUE-SCRIPT-196: the image name of a process (a test process's parent: is it the
   *  call's shell?), or null. Absent = unknown, so no test process is VISIBLE. */
  parentImage?: (pid: number) => Promise<string | null>;
  /** Is this pid running? (A run named by GUPPY_TEST_RUN; its createdMs is checked by the scan.) */
  pidAlive?: (pid: number) => boolean;
  /** How long one lease request waits for a queued agent's slot before answering 'wait'. */
  leasePollMs?: number;
}

/**
 * HEAVY-LOCK-OPAQUE-SCRIPT-196: what the heavy preload (resources/heavyjob/heavy-preload.cjs) asks,
 * from inside a test process (`node --test`, or a suite runner) an agent started, however it was
 * started (a node script, a bash script: the PreToolUse classifier cannot read those). This is
 * COOPERATIVE, not enforcement: it rides on NODE_OPTIONS, which an agent can unset. So a broker
 * the preload cannot reach fails open, and every fail-open is a hive row (Jim SHOULD 1).
 */
export interface HeavyLeaseRequest {
  /** HEAVY-LOCK-RESERVATION-RELEASE: 'unreserve' (the `heavy release` command) gives up the
   *  caller's reservation and its queue place; 'status' (`heavy status`) reads the lock. */
  op?: 'acquire' | 'release' | 'unreserve' | 'status';
  /** acquire: the test process, its creation time (epoch ms) and its parent. */
  pid?: number;
  createdMs?: number;
  ppid?: number;
  /** The `node --test` file arguments as the process got them. */
  files?: string[];
  /** `node --test` with no files (node's own discovery: a suite). */
  suite?: boolean;
  /** A suite runner's argv after node (argv[1] is run-tests.cjs): classified as PreToolUse would. */
  runner?: string[];
  /** GUPPY_TEST_RUN as the process inherited it: '<pid>:<createdMs>' of an enclosing classified run. */
  parentRun?: string;
  /** release: the lease an acquire answered. */
  leaseId?: string;
  /** unreserve: a queued agent the freed slot goes to first (else the oldest waiter). */
  to?: string;
}
export type HeavyLeaseAnswer =
  | { state: 'light'; run: string; why: string }
  | { state: 'held'; run: string; leaseId: string | null; why: string }
  | { state: 'wait'; position: number; holders: string[] }
  | { state: 'released' }
  | HeavyUnreserveAnswer
  | { state: 'status'; holders: string[]; waiters: string[]; reserved: Array<{ agentId: string; until: string }> };
/** `reserved`/`queued`: what the caller gave up; `next`: who the slot is now reserved for (null: no
 *  one waits, so it is free); `to`: the asked-for agent was not queued, so it went in FIFO order;
 *  `waiting`: a test process of the caller's still waits in a lease and will queue it again. */
export type HeavyUnreserveAnswer = { state: 'unreserved'; reserved: boolean; queued: boolean; next: string | null; to?: 'not-queued'; waiting?: true };
/** How long one lease request may wait (a long poll; the preload asks again). */
export const HEAVY_LEASE_POLL_MS = 25_000;
/** A test process is the call's OWN node when its parent is the call's shell (or a pass-through
 *  prefix the classifier strips): Jim MUST A. A node, python or any other program is not. */
const CALL_PARENT = /^(bash|sh|zsh|dash|cmd|powershell|pwsh|env|timeout|nice|nohup|setsid|time)(\.exe)?$/i;
const normFile = (f: string): string => f.replace(/\\/g, '/').replace(/^(\.\/)+/, '').toLowerCase();

export const HEAVY_TTL_MS = 60 * 60_000;
/** HEAVY-LOCK-SELF-WAIT: how long a freed slot is kept for the queued agent it was offered to.
 *  A waiter stays queued until it is offered a slot, acquires, gives its place up (`heavy release`)
 *  or its PTY is gone. HEAVY-QUEUE-WAIT-DROPS: NOT until a timer runs out. The old "not denied
 *  again for HEAVY_TTL_MS" drop (Andy N2) was shorter than a normal hold: a stage bench holds the
 *  slot ~90 min, and an agent told "do not retry, you will be told" never asks again, so it fell
 *  out of the queue at 60 min and re-queued at the back (Andy, 3x on 2026-10-21). HEAVY_TTL_MS is
 *  the HOLDER's TTL only. A waiter that moved on takes a reservation that lapses in
 *  HEAVY_RESERVE_MS and passes on; a dead one is reaped by liveness (`alive`). */
export const HEAVY_RESERVE_MS = 5 * 60_000;
export const HEAVY_SCAN_MS = 20_000;
export const HEAVY_SCAN_MISSES = 2;

/**
 * HEAVY-LOCK-SELF-WAIT: the "slot free" notice, on both rails as closing time does. The mail wakes an
 * IDLE agent: sender `system` always wakes under READS-QUIET-NOREPLY, and `wake: "now"` is the
 * explicit second guarantee; inform with no reply carries no obligation. The steer reaches a BUSY
 * agent at its next hook. Pure: main sends it.
 */
export function heavySlotFreeNotice(agentId: string, kind: string, until: number): {
  message: { to: string; act: 'inform'; requires_reply: false; subject: string; body: string; wake: 'now' };
  from: 'system';
  steer: string;
} {
  const at = `${new Date(until).toISOString().slice(11, 16)}Z`;
  const subject = `HEAVY SLOT FREE: the ${kind} you were denied can run now; the slot is reserved for you until ${at}`;
  const body = `The heavy-job slot you were queued for is now reserved for you until ${at}. Run your ${kind} now if you still need it; if you do not run it by then, it passes to the next agent in the queue. If you no longer need it, run \`heavy release\` so it passes on at once (\`heavy release --to <agent>\` gives it to that queued agent first). No reply is needed.`;
  return { message: { to: agentId, act: 'inform', requires_reply: false, subject, body, wake: 'now' }, from: 'system', steer: `${subject}.` };
}

/**
 * LOCK-WAIT-NOTICES (1.1.87): the notice for an agent that has left the queue without a slot: a
 * reservation not used within HEAVY_RESERVE_MS passes on, so the agent is no longer queued, and it
 * was told to wait for a notice, so it gets one. Same rails and wake as heavySlotFreeNotice. Pure:
 * main sends it. The 'stale' text is kept for callers, but since HEAVY-QUEUE-WAIT-DROPS the lock
 * never drops a waiter by age, so it never asks for it.
 */
export function heavyWaitLapsedNotice(agentId: string, kind: string, why: 'stale' | 'expired'): {
  message: { to: string; act: 'inform'; requires_reply: false; subject: string; body: string; wake: 'now' };
  from: 'system';
  steer: string;
} {
  const subject = why === 'stale'
    ? `HEAVY QUEUE LEFT: you are no longer queued for the ${kind} you were denied`
    : `HEAVY SLOT LAPSED: the ${kind} slot reserved for you was not used in ${Math.round(HEAVY_RESERVE_MS / 60_000)} min; you are no longer queued`;
  const body = why === 'stale'
    ? `You were taken out of the heavy-job queue because you had not asked again for ${Math.round(HEAVY_TTL_MS / 60_000)} min while the slot stayed busy, so no "HEAVY SLOT FREE" notice will come. If you still need your ${kind}, run it again to queue again. No reply is needed.`
    : `The heavy-job slot reserved for you was not used in time and has passed to the next agent in the queue (or is free). If you still need your ${kind}, run it again to queue again. No reply is needed.`;
  return { message: { to: agentId, act: 'inform', requires_reply: false, subject, body, wake: 'now' }, from: 'system', steer: `${subject}.` };
}

export function heavyUnlimitedNotice(agentId: string, kind: string): {
  message: { to: string; act: 'inform'; requires_reply: false; subject: string; body: string; wake: 'now' };
  from: 'system'; steer: string;
} {
  const subject = `HEAVY LIMIT OFF: the ${kind} you queued can run now`;
  return { message: { to: agentId, act: 'inform', requires_reply: false, subject, body: 'Heavy jobs are now unlimited. Run your queued job now if you still need it. No reply is needed.', wake: 'now' }, from: 'system', steer: `${subject}.` };
}

export type HeavyDecision = { allow: true; acquired: boolean } | { allow: false; reason: string; holders: HeavyHolder[] };

/**
 * HEAVY-LOCK-SELF-WAIT (1.1.81). The lock used to be deny-only: a denied agent was told to "run it
 * later" and never told WHEN, so agents wrote their own pollers. A poller in the same call as a
 * suite then waited on that call's own slot (Jim, 2026-10-02: 10 min, then orphan-kept). Now a
 * denied agent is QUEUED (FIFO, once). A freed slot is RESERVED for the oldest live waiter for
 * HEAVY_RESERVE_MS, and that agent is NOTIFIED (deps.notify); no one else may take it meanwhile.
 * An unused reservation passes on. A reservation counts against the limit like a holder.
 */
export class HeavyJobLock {
  private readonly holders = new Map<string, HeavyHolder>();
  /** `procs`: HEAVY-LOCK-OPAQUE-SCRIPT-196 (Jim MUST C), the test processes waiting in a lease
   *  request; `hooked`: the agent was also denied at PreToolUse (it waits for the notice, not a
   *  process). A waiter with no live process and no hooked deny has left: the scan drops it. */
  private readonly waiters: Array<{ agentId: string; kind: HeavyKind; since: number; procs: Array<{ pid: number; createdMs: number }>; hooked: boolean; exclusive: boolean }> = [];
  private readonly reservations = new Map<string, { kind: HeavyKind; until: number; procs: Array<{ pid: number; createdMs: number }>; hooked: boolean; exclusive: boolean }>();
  /** HEAVY-LOCK-OPAQUE-SCRIPT-196: each agent's recent calls that ARE one `node --test` of named files
   *  (testInvocation), each consumed by the one test process it starts (Jim MUST A). */
  private readonly testCalls = new Map<string, Array<{ callId: string; files: string[]; start: number; end: number | null; used: boolean }>>();
  /** Held leases by id ('lease:<pid>:<createdMs>'): released by the preload at exit, or by the scan. */
  private readonly leases = new Map<string, { agentId: string; pid: number; createdMs: number; run: string }>();
  /** Classified runs ('<pid>:<createdMs>') a nested test process may name in GUPPY_TEST_RUN (MUST B). */
  private readonly runs = new Map<string, { agentId: string; held: boolean }>();
  /** Agents queued only by a waiting test process (no PreToolUse deny told them to wait). */
  private readonly leaseOnly = new Set<string>();
  private timer: unknown = null;
  /** IDLE-MEANS-IDLE: told of every change to who holds, waits for or has a slot reserved. */
  private readonly listeners = new Set<() => void>();
  /** LOCK-WAIT-NOTICES: the agent whose acquire is running (its own answer tells it; no notice). */
  private calling: string | null = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private readonly d: HeavyLockDeps) {
    this.now = d.now ?? Date.now;
    this.setTimer = d.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t; });
    this.clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  }

  /** IDLE-MEANS-IDLE: `cb` runs once per change to the holders, the queue or the reservations (an
   *  acquire, a re-entry that makes the job a background one, a deny, a reserve, a release, an
   *  expired or dropped reservation, a dropped waiter). It runs inside the lock's own call: read the
   *  snapshots later, not from `cb`. Returns the unsubscribe. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }
  /** A Settings change may create capacity without a holder releasing. Promote queued
   *  agents immediately so the new slot is not stranded until another release. */
  limitChanged(): void {
    this.expire();
    this.grant();
  }

  private changed(): void {
    for (const cb of [...this.listeners]) { try { cb(); } catch { /* a display listener never breaks the lock */ } }
  }

  /** The current holders (fleet.json, the deny text, tests). Expired ones are released first.
   *  HEAVY-JOB-LOCK-FAILOPEN: with how long each has held the slot and what keeps it (so agents read
   *  fleet.json instead of polling the log). */
  snapshot(): Array<{ agentId: string; kind: HeavyKind; command: string; since: string; heldMs: number; background: boolean; openCalls: number; seenRunning: boolean; lastProbe: 'ok' | 'failed' | null; exclusive?: true }> {
    this.expire();
    const t = this.now();
    return [...this.holders.values()].map((h) => ({
      agentId: h.agentId, kind: h.kind, command: h.command, since: new Date(h.since).toISOString(), heldMs: t - h.since,
      background: h.background, openCalls: h.calls.size, seenRunning: h.seenRunning, lastProbe: h.lastProbe,
      ...(h.exclusive ? { exclusive: true as const } : {})
    }));
  }

  /** PreToolUse: a heavy call from `agentId`. Take a slot, share the agent's own, or deny. */
  acquire(agentId: string, cls: HeavyClass, command: string, callId: string, background: boolean): HeavyDecision {
    this.calling = agentId;
    try { return this.acquireAs(agentId, cls, command, callId, background); } finally { this.calling = null; }
  }

  private acquireAs(agentId: string, cls: HeavyClass, command: string, callId: string, background: boolean): HeavyDecision {
    const limit = this.d.limit();
    if (!cls.heavy || !cls.kind) return { allow: true, acquired: false };
    // Off: no limit, but the heavy call is still visible (god: log 'heavy (unlimited)').
    if (limit === 'off') { this.log({ kind: 'heavy-lock', action: 'unlimited', agentId, heavyKind: cls.kind, why: cls.why ?? null }); return { allow: true, acquired: false }; }
    this.expire();
    // A slot that is free while agents wait (the limit was raised) goes to them first. Andy N3: a
    // slot reserved here for the CALLER itself is taken at once below, so it is not notified.
    if (this.waiters.length) this.grant(agentId);
    // HEAVY-SLOT-EXCLUSIVE-192: a whole suite or a bench runs alone.
    const excl = heavyExclusive(cls);
    // HEAVY-LOCK-SELF-WAIT: a slot reserved for THIS agent is its own; the others count as taken.
    const reserved = this.reservations.has(agentId);
    const mine = this.holders.get(agentId);
    if (mine) {
      // HEAVY-SLOT-EXCLUSIVE-192: an exclusive call of an agent that holds a shared slot waits, like
      // anyone's, until the other holders are done (its own slot stays held meanwhile). fits(), not
      // admits(): it already holds, so a waiter behind it does not put it back in the queue (Jim MUST-1).
      if (excl && !mine.exclusive && !reserved && !this.fits(agentId, true, limit)) return this.deny(agentId, cls, limit, callId);
      // Re-entrant: an agent's heavy calls share its one slot (and refresh its TTL).
      const flipped = background && !mine.background;
      const alone = excl && !mine.exclusive;
      if (excl && reserved) { this.reservations.delete(agentId); this.dequeue(agentId); }
      mine.calls.add(callId); mine.background = mine.background || background; mine.touched = this.now(); mine.misses = 0;
      if (alone) mine.exclusive = true;
      if (cls.provisional) mine.provisional.add(callId); else mine.definite = true;
      mine.windows.push({ callId, start: this.now(), end: null });
      this.log({ kind: 'heavy-lock', action: 'reenter', agentId, heavyKind: cls.kind, command: command.slice(0, 200), ...(alone ? { exclusive: true } : {}) });
      if (flipped || alone) this.changed();
      this.arm();
      return { allow: true, acquired: false };
    }
    if (!reserved && !this.admits(agentId, excl, limit)) return this.deny(agentId, cls, limit, callId);
    if (reserved && excl && !this.fits(agentId, true, limit)) {
      // HEAVY-SLOT-EXCLUSIVE-192 (Jim MUST-1): a slot reserved for a shared job is not the empty
      // machine. The exclusive call goes back to the HEAD of the queue: nothing passes it or joins the
      // others, and it is told "HEAVY SLOT FREE" when they are done.
      const r = this.reservations.get(agentId)!;
      this.reservations.delete(agentId);
      this.dequeue(agentId);
      this.waiters.unshift({ agentId, kind: cls.kind as HeavyKind, since: this.now(), procs: r.procs, hooked: r.hooked, exclusive: true });
      return this.deny(agentId, cls, limit, callId);
    }
    if (reserved) this.reservations.delete(agentId);
    this.dequeue(agentId);
    this.leaseOnly.delete(agentId);
    this.holders.set(agentId, { agentId, kind: cls.kind, command: command.slice(0, 200), since: this.now(), touched: this.now(), calls: new Set([callId]), background, provisional: new Set(cls.provisional ? [callId] : []), definite: !cls.provisional, misses: 0, seenRunning: false, attributed: new Map(), windows: [{ callId, start: this.now(), end: null }], lastProbe: null, jobs: new Map(), exclusive: excl });
    this.log({ kind: 'heavy-lock', action: 'acquire', agentId, heavyKind: cls.kind, command: command.slice(0, 200), background, limit, ...(reserved ? { reserved: true } : {}), ...(excl ? { exclusive: true } : {}) });
    this.changed();
    this.arm();
    return { allow: true, acquired: true };
  }

  /**
   * HEAVY-SLOT-EXCLUSIVE-192: may `agentId` take a slot now (not counting a slot or reservation of
   * its own)? Never ahead of a queued agent: a free slot left behind an exclusive waiter at the head
   * is not for a newcomer, or the waiter would never see the machine empty (FIFO keeps an exclusive
   * from starving). Then fits().
   */
  private admits(agentId: string, exclusive: boolean, limit: number): boolean {
    const at = this.waiters.findIndex((w) => w.agentId === agentId);
    if ((at < 0 ? this.waiters.length : at) > 0) return false;
    return this.fits(agentId, exclusive, limit);
  }

  /** Not beside an exclusive holder or reservation; an exclusive call only when no one else holds or
   *  has a slot reserved; otherwise while fewer than `limit` are taken. */
  private fits(agentId: string, exclusive: boolean, limit: number): boolean {
    let others = 0;
    for (const h of this.holders.values()) { if (h.agentId === agentId) continue; if (h.exclusive) return false; others++; }
    for (const [a, r] of this.reservations) { if (a === agentId) continue; if (r.exclusive) return false; others++; }
    return exclusive ? others === 0 : this.holders.size + this.reservations.size < limit;
  }

  private deny(agentId: string, cls: HeavyClass, limit: number, callId: string): HeavyDecision {
    const kind = cls.kind as HeavyKind;
    const excl = heavyExclusive(cls);
    const holders = [...this.holders.values()];
    const position = this.enqueue(agentId, kind, !callId.startsWith('lease:'), excl);
    const who = holders.map((h) => `${h.agentId} (${h.kind}: ${h.command.slice(0, 80)}, since ${new Date(h.since).toISOString().slice(11, 19)}Z)`).join('; ');
    const others = [...this.reservations.entries()].map(([a, r]) => `reserved for ${a} until ${new Date(r.until).toISOString().slice(11, 19)}Z`).join('; ');
    const held = holders.length ? `${holders.length === 1 ? 'it is' : 'they are'} held by ${who}` : 'no job is running';
    // HEAVY-SLOT-EXCLUSIVE-192: with 2+ slots, say why a free slot is not yours (one slot is always alone).
    const alone = limit > 1 && (excl || holders.some((h) => h.exclusive) || [...this.reservations.values()].some((r) => r.exclusive) || this.waiters.some((w) => w.exclusive && w.agentId !== agentId))
      ? ' A whole test suite or a bench runs alone: it starts only when every slot is free, and nothing else starts beside it or ahead of it.' : '';
    const reason = `Denied by HEAVY-JOB-LOCK: the machine allows ${limit} heavy job${limit === 1 ? '' : 's'} at once and ${held}${others ? ` (${others})` : ''}.${alone} You are QUEUED (position ${position}): when a slot frees it is reserved for you for ${Math.round(HEAVY_RESERVE_MS / 60_000)} min and you are told "HEAVY SLOT FREE". Do not retry this or a variant of it now, and do not poll for the slot: carry on with light work (single test files, reads, edits are not limited) until you are told.`;
    // Jim N3: the denied command's CLASS is logged, not the command itself.
    this.log({ kind: 'heavy-lock', action: 'deny', agentId, heavyKind: kind, why: cls.why ?? null, holders: holders.map((h) => ({ agentId: h.agentId, kind: h.kind, since: new Date(h.since).toISOString() })), limit, position, ...(excl ? { exclusive: true } : {}) });
    this.changed();
    return { allow: false, reason, holders };
  }

  /** The queue as fleet.json shows it (oldest first), with the open reservations. */
  queueSnapshot(): { waiters: Array<{ agentId: string; kind: HeavyKind; since: string; position: number; exclusive?: true }>; reserved: Array<{ agentId: string; kind: HeavyKind; until: string; exclusive?: true }> } {
    this.expire();
    const ex = (on: boolean): { exclusive?: true } => (on ? { exclusive: true } : {});
    return {
      waiters: this.waiters.map((w, i) => ({ agentId: w.agentId, kind: w.kind, since: new Date(w.since).toISOString(), position: i + 1, ...ex(w.exclusive) })),
      reserved: [...this.reservations.entries()].map(([agentId, r]) => ({ agentId, kind: r.kind, until: new Date(r.until).toISOString(), ...ex(r.exclusive) }))
    };
  }

  /** Queue a denied agent once (FIFO); its 1-based position. */
  private enqueue(agentId: string, kind: HeavyKind, hooked = true, exclusive = false): number {
    const i = this.waiters.findIndex((w) => w.agentId === agentId);
    // A re-deny keeps its place; `since` is its latest ask (the reserve row's waitedMs). No TTL
    // runs on it (HEAVY-QUEUE-WAIT-DROPS).
    if (hooked) this.leaseOnly.delete(agentId);
    if (i >= 0 && hooked) this.waiters[i].hooked = true;
    if (i >= 0) { this.waiters[i].since = this.now(); this.waiters[i].exclusive ||= exclusive; return i + 1; }
    this.waiters.push({ agentId, kind, since: this.now(), procs: [], hooked, exclusive });
    if (!hooked) this.leaseOnly.add(agentId);
    return this.waiters.length;
  }

  private dequeue(agentId: string): void {
    const i = this.waiters.findIndex((w) => w.agentId === agentId);
    if (i >= 0) this.waiters.splice(i, 1);
  }

  /** Offer every free slot to the oldest live waiter: reserve it, log it, tell the agent (not
   *  `caller`, the agent whose own acquire is running and takes the slot at once; Andy N3). */
  private grant(caller?: string): void {
    const limit = this.d.limit();
    if (limit === 'off') {
      const pending = [...this.waiters, ...[...this.reservations.entries()].map(([agentId, r]) => ({ agentId, kind: r.kind }))];
      this.waiters.length = 0; this.reservations.clear();
      if (pending.length) this.changed();
      for (const w of pending) { try { if (!this.d.alive || this.d.alive(w.agentId)) this.d.notifyUnlimited?.(w.agentId, w.kind); } catch { /* best effort */ } }
      return;
    }
    // HEAVY-SLOT-EXCLUSIVE-192: FIFO; an exclusive waiter at the head waits for the empty machine,
    // and the waiters behind it wait with it.
    while (this.waiters.length && this.fits(this.waiters[0].agentId, this.waiters[0].exclusive, limit)) {
      const w = this.waiters.shift()!;
      if (this.d.alive && !this.d.alive(w.agentId)) { this.log({ kind: 'heavy-lock', action: 'queue-dropped', agentId: w.agentId, reason: 'gone' }); this.changed(); continue; }
      // HEAVY-QUEUE-WAIT-DROPS: no drop by age here (the old Andy N2 "stale" drop). A waiter that
      // moved on takes this reservation, which lapses in HEAVY_RESERVE_MS and passes on.
      const until = this.now() + HEAVY_RESERVE_MS;
      this.reservations.set(w.agentId, { kind: w.kind, until, procs: w.procs, hooked: w.hooked, exclusive: w.exclusive });
      this.log({ kind: 'heavy-lock', action: 'reserve', agentId: w.agentId, heavyKind: w.kind, until: new Date(until).toISOString(), waitedMs: this.now() - w.since, ...(w.exclusive ? { exclusive: true } : {}) });
      this.changed();
      // HEAVY-LOCK-OPAQUE-SCRIPT-196: a waiter that is only a waiting test process takes the slot
      // itself (its lease request is told); the agent was never told to wait for a notice.
      if (w.agentId === caller) continue;
      if (!w.hooked) continue;
      try { this.d.notify?.(w.agentId, w.kind, until); } catch { /* best effort: the reservation stands */ }
    }
    this.arm();
  }

  /** HEAVY-LOCK-BG-LAPSE-189 (early release): PostToolUse of a call held only because its script was
   *  unreadable at PreToolUse. `reclassify` runs the classifier again now that the call has run (the
   *  script exists): light, and nothing else of the holder heavy, frees the slot at once instead of
   *  holding a backgrounded light job until it exits. Still unreadable, or heavy, keeps it. Only ever
   *  for such a call: a definite heavy call is freed by its call id alone (Andy N1). Only for a
   *  background holder: a foreground one is freed by callDone, after its orphan check (Jim N2). */
  settle(agentId: string, callId: string, reclassify: () => HeavyClass): void {
    const h = this.holders.get(agentId);
    if (!h || !h.background || h.definite || !h.provisional.has(callId) || h.provisional.size !== 1) return;
    let c: HeavyClass;
    try { c = reclassify(); } catch { return; }
    if (c.heavy) return;
    this.log({ kind: 'heavy-lock', action: 'settled-light', agentId, heavyKind: h.kind });
    h.calls.clear();
    this.release(agentId, 'settled-light');
  }

  /** PostToolUse of a heavy call: a FOREGROUND call's job is done. The slot is freed when the
   *  agent has no foreground call left and no background job. */
  callDone(agentId: string, callId: string): void {
    const h = this.holders.get(agentId);
    if (!h || !h.calls.delete(callId)) return;
    // (b) The call's window closes now: what it started from here on is no longer this job.
    const end = this.now();
    for (const w of h.windows) if (w.callId === callId && w.end === null) w.end = end;
    if (h.calls.size || h.background) return;
    // Jim N2: a foreground call can return (a timeout, a detached child) while its heavy job
    // lives on. ONE quick descendant check before releasing: a heavy child keeps the slot and
    // turns the holder into a background one (the watcher then frees it when the child exits).
    if (this.d.probe && this.d.roots) {
      void this.heavyAgents().then((busy) => {
        const cur = this.holders.get(agentId);
        if (!cur || cur.calls.size || cur.background) return;
        if (busy?.busy.has(agentId)) { cur.background = true; cur.seenRunning = true; this.log({ kind: 'heavy-lock', action: 'orphan-kept', agentId, heavyKind: cur.kind }); this.changed(); this.arm(); return; }
        // (a) FAIL CLOSED: a failed listing says nothing about the job (most likely a TIMEOUT on a
        // loaded machine, i.e. exactly when a second heavy job hurts most). Keep the slot as a
        // background holder; the watcher frees it on two clean scans without it, or the TTL.
        if (!busy) { cur.background = true; cur.lastProbe = 'failed'; this.log({ kind: 'heavy-lock', action: 'probe-failed-kept', agentId, heavyKind: cur.kind }); this.changed(); this.arm(); return; }
        this.release(agentId, 'posttool');
      });
      return;
    }
    this.release(agentId, 'posttool');
  }

  /** The holders that are still BUSY now (one probe), or null.
   *  Jim MF3: NOT by classifying command lines. Real heavy jobs hide behind wrappers (Claude's
   *  `bash -c "... eval '...'"`, `node ...npm-cli.js ci`, `cmd /s /c ""npm.cmd" ci"`, electron-builder's
   *  cli.js, Claude's PowerShell launcher that never shows the command at all). A holder is busy
   *  while its agent's PTY tree has ANY descendant CREATED at or after its acquire: exact for every
   *  wrapper, shim and tool, and conservative (the agent's other calls only extend the hold). The
   *  PTY root itself and its long-lived children (created earlier) never count. */
  private async heavyAgents(given?: { procs: ProcRow[] | null }): Promise<{ busy: Set<string>; seen: Set<string> } | null> {
    if (!this.d.probe || !this.d.roots) return null;
    let procs: ProcRow[] | null;
    if (given) procs = given.procs;
    else try { procs = await this.d.probe(); } catch { procs = null; }
    // Jim MF4: a failed, empty or createdMs-less listing (most likely a TIMEOUT while heavy jobs load
    // the machine) is UNKNOWN, never "nothing running": the caller counts no miss.
    if (!procs || !procs.length || !procs.some((p) => typeof p.createdMs === 'number')) {
      this.log({ kind: 'heavy-lock', action: 'probe-failed', rows: procs ? procs.length : null });
      for (const h of this.holders.values()) h.lastProbe = 'failed';
      return null;
    }
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    const rootOf = new Map(this.d.roots().map((r) => [r.pid, r.agentId]));
    const ownerOf = (pid: number): string | null => {
      const seen = new Set<number>([pid]); let child = byPid.get(pid); // start ABOVE the process: a root is not its own descendant
      while (child && !seen.has(child.parentPid)) {
        const up = byPid.get(child.parentPid);
        // Jim (PID reuse): a "parent" created AFTER its child is a reused PID, not the real parent.
        if (up && typeof up.createdMs === 'number' && typeof child.createdMs === 'number' && up.createdMs > child.createdMs) return null;
        const a = rootOf.get(child.parentPid);
        if (a) return a;
        seen.add(child.parentPid); child = up;
      }
      return null;
    };
    const busy = new Set<string>();
    // The holders whose PTY root IS in this listing: only for them may an absence count as a miss.
    const rootsSeen = new Set<string>(procs.flatMap((p) => { const a = rootOf.get(p.pid); return a ? [a] : []; }));
    // (b) HEAVY-JOB-LOCK-FAILOPEN: a process is the holder's JOB only when it, or an ancestor below
    // the PTY root, was CREATED inside one of the holder's heavy-call windows. Creed's own
    // wait-for-release loop (a later call) used to keep his slot for ~5 min: any descendant created
    // after the acquire counted.
    const t = this.now();
    const inWindow = (h: HeavyHolder, created: number | undefined): boolean => typeof created === 'number'
      && h.windows.some((w) => created >= w.start - HEAVY_CREATED_SKEW_MS
        && created <= Math.min((w.end ?? t) + HEAVY_CALL_SLACK_MS, w.start + HEAVY_CALL_SPAWN_MS));
    const ofJob = (h: HeavyHolder, pid: number): boolean => {
      const seen = new Set<number>();
      let cur = byPid.get(pid);
      while (cur && !seen.has(cur.pid) && !rootOf.has(cur.pid)) {
        if (inWindow(h, cur.createdMs)) return true;
        seen.add(cur.pid);
        const up = byPid.get(cur.parentPid);
        // Jim (PID reuse): a "parent" created after its child is not its parent.
        if (up && typeof up.createdMs === 'number' && typeof cur.createdMs === 'number' && up.createdMs > cur.createdMs) return false;
        cur = up;
      }
      return false;
    };
    for (const p of procs) {
      if (typeof p.createdMs !== 'number') continue;
      const a = ownerOf(p.pid);
      const h = a ? this.holders.get(a) : undefined;
      if (h && p.createdMs >= h.since - HEAVY_CREATED_SKEW_MS && ofJob(h, p.pid)) { busy.add(h.agentId); h.attributed.set(p.pid, p.createdMs); }
    }
    for (const h of this.holders.values()) h.lastProbe = 'ok';
    // Jim (orphans): a job detached with & / nohup whose shell has exited loses its parent chain.
    // A pid attributed to a holder on an earlier scan still counts while it persists with the SAME
    // creation time (a reused pid has another); pids no longer listed are forgotten.
    for (const h of this.holders.values()) {
      for (const [pid, created] of h.attributed) {
        const p = byPid.get(pid);
        if (p && p.createdMs === created) busy.add(h.agentId); else h.attributed.delete(pid);
      }
    }
    // HEAVY-LOCK-OPAQUE-SCRIPT-196: a held lease's test process keeps its agent busy while it runs
    // (it may have been created long before its lease: it waited in the queue).
    for (const l of this.leases.values()) if (procLive(byPid, l.pid, l.createdMs)) busy.add(l.agentId);
    return { busy, seen: rootsSeen };
  }

  /** The holder's PTY exited: its jobs are gone with it. */
  agentGone(agentId: string): void {
    // HEAVY-LOCK-SELF-WAIT: a gone agent neither waits nor keeps a reservation.
    const queued = this.waiters.some((w) => w.agentId === agentId);
    this.dequeue(agentId);
    const had = this.reservations.delete(agentId);
    if (had) this.log({ kind: 'heavy-lock', action: 'reserve-dropped', agentId, reason: 'pty-exit' });
    if (queued || had) this.changed();
    if (this.holders.has(agentId)) this.release(agentId, 'pty-exit');
    // HEAVY-SLOT-EXCLUSIVE-192: a gone exclusive head held back the waiters behind it.
    else if (queued) this.grant();
    else if (had) this.grant();
  }

  /** HEAVY-LOCK-RESERVATION-RELEASE (card, 2026-10-04: Jim got HEAVY SLOT FREE, wanted to hand it to
   *  Creed and could only let it idle for 5 min). The agent gives up its unused reservation and its
   *  queue place (`heavy release`): the slot passes on at once, to `to` first when that agent is
   *  queued, else to the oldest waiter. A held slot is not touched: it frees when its job ends. */
  unreserve(agentId: string, to?: string): HeavyUnreserveAnswer {
    // Jim INFO 3: the route takes any string; an agent id is short, and `to` is logged verbatim.
    if (to !== undefined) to = to.slice(0, 80);
    const own = this.waiters.find((w) => w.agentId === agentId);
    const queued = !!own;
    // Jim INFO 1: a test process of the caller's still waiting in a lease asks again within
    // HEAVY_LEASE_POLL_MS and queues the agent again (at the back): the answer says so.
    const waiting = !!own?.procs.length || !!this.reservations.get(agentId)?.procs.length;
    this.dequeue(agentId);
    this.leaseOnly.delete(agentId);
    const r = this.reservations.get(agentId);
    const reserved = this.reservations.delete(agentId);
    let missed = false;
    if (r && to !== undefined && to !== agentId) {
      const i = this.waiters.findIndex((w) => w.agentId === to);
      if (i > 0) this.waiters.unshift(...this.waiters.splice(i, 1));
      missed = i < 0;
    }
    if (r) this.log({ kind: 'heavy-lock', action: 'reserve-released', agentId, heavyKind: r.kind, ...(to ? { to } : {}) });
    else if (queued) this.log({ kind: 'heavy-lock', action: 'queue-left', agentId });
    if (reserved || queued) this.changed();
    const before = new Set(this.reservations.keys());
    // HEAVY-SLOT-EXCLUSIVE-192: a queue place given up may have held back the waiters behind it.
    if (reserved || queued) this.grant();
    const next = [...this.reservations.keys()].find((a) => !before.has(a)) ?? null;
    if (!this.watching() && this.timer) { this.clearTimer(this.timer); this.timer = null; }
    return { state: 'unreserved', reserved, queued, next, ...(missed ? { to: 'not-queued' as const } : {}), ...(waiting ? { waiting: true as const } : {}) };
  }

  /** HEAVY-LOCK-RELEASE-LAG-197: the heavy call `callId` runs in the job `job` Guppy holds (HeavyJobs 'held'). */
  noteJob(agentId: string, callId: string, job: string): void {
    const h = this.holders.get(agentId);
    if (!h || !h.windows.some((w) => w.callId === callId)) return;
    const js = h.jobs.get(callId) ?? new Map<string, boolean>();
    if (!js.has(job)) js.set(job, false);
    h.jobs.set(callId, js);
  }

  /** HEAVY-LOCK-RELEASE-LAG-197: nothing of `callId` is left in its job (the helper's exit notice,
   *  confirmed by a list; or the job poll). The slot is freed now, not on the watcher's second clean
   *  scan, when every heavy call of the holder ran in a held job and all of them have exited. Any
   *  other call (unwrapped, a lease, a job that was never held) leaves it to the watcher. */
  jobExited(agentId: string, callId: string, job: string): void {
    const h = this.holders.get(agentId);
    const js = h?.jobs.get(callId);
    if (!h || !js || !js.has(job)) return;
    js.set(job, true);
    if (!h.windows.every((w) => this.callJobsExited(h, w.callId))) return;
    h.calls.clear();
    this.release(agentId, 'job-exit');
  }

  /** Jim MUST 1: every window of `callId` had its own held job, and all of those jobs have exited. */
  private callJobsExited(h: HeavyHolder, callId: string): boolean {
    const js = h.jobs.get(callId);
    if (!js) return false;
    if (js.size < h.windows.filter((w) => w.callId === callId).length) return false;
    return [...js.values()].every((exited) => exited);
  }

  private release(agentId: string, reason: 'posttool' | 'process-exit' | 'job-exit' | 'pty-exit' | 'ttl' | 'expired-still-running' | 'settled-light'): void {
    const h = this.holders.get(agentId);
    if (!h) return;
    this.holders.delete(agentId);
    this.log({ kind: 'heavy-lock', action: 'release', agentId, heavyKind: h.kind, reason, heldMs: this.now() - h.since });
    this.changed();
    // HEAVY-LOCK-SELF-WAIT: the freed slot goes to the oldest waiter (reserved), not to whoever asks first.
    this.grant();
    if (!this.watching() && this.timer) { this.clearTimer(this.timer); this.timer = null; }
  }

  /** The watcher has work: a slot held or reserved, or a test process waiting (Jim MUST C: a dead
   *  waiter must leave the queue even while nobody holds). */
  private watching(): boolean {
    return this.holders.size > 0 || this.reservations.size > 0 || this.waiters.some((w) => w.procs.length > 0);
  }

  /** LOCK-WAIT-NOTICES: tell an agent it left the queue: not the one whose own call is running, and
   *  not a gone one (no PTY to tell; Dwight MUST: a lapsed reservation reaches here without grant()'s
   *  gone check). */
  private lapse(agentId: string, kind: HeavyKind, why: 'stale' | 'expired'): void {
    if (agentId === this.calling) return;
    // HEAVY-LOCK-OPAQUE-SCRIPT-196: an agent queued only by a waiting test process was never told
    // to wait for a notice (its process waits, or has gone).
    if (this.leaseOnly.has(agentId)) return;
    try {
      if (this.d.alive && !this.d.alive(agentId)) return;
      this.d.notifyLapse?.(agentId, kind, why);
    } catch { /* best effort: the lock goes on */ }
  }

  /** `alive` as the sweep reads it: an alive check that throws counts as live (never breaks the lock). */
  private alive(agentId: string): boolean {
    try { return !this.d.alive || this.d.alive(agentId); } catch { return true; }
  }

  private expire(): void {
    const t = this.now();
    // HEAVY-QUEUE-WAIT-DROPS: a waiter keeps its place until it is served or leaves on purpose; the
    // only sweep is by LIVENESS: a waiter whose agent is gone (no PTY) leaves the queue on schedule,
    // not only when a slot next frees (grant() keeps its own gone check): until then fleet.json and
    // the displays said QUEUED #n for an agent the lock could never serve. Not told (no PTY). Never
    // by age: a live waiter outlives any hold (the Jim NIT 1 "stale" sweep bounded the wait to
    // HEAVY_TTL_MS, shorter than a ~90 min stage bench).
    // HEAVY-SLOT-EXCLUSIVE-192: a dropped waiter may have held back the ones behind it (an exclusive
    // head waits for the empty machine), so the queue is offered the free slots again.
    let left = false;
    for (const w of [...this.waiters]) {
      if (!this.d.alive || this.alive(w.agentId)) continue;
      this.dequeue(w.agentId);
      this.log({ kind: 'heavy-lock', action: 'queue-dropped', agentId: w.agentId, reason: 'gone' });
      this.changed();
      left = true;
    }
    // Jim N5: a TTL expiry while the watcher last SAW the job running is logged distinctly.
    for (const h of [...this.holders.values()]) if (t - h.touched >= HEAVY_TTL_MS) this.release(h.agentId, h.seenRunning ? 'expired-still-running' : 'ttl');
    // HEAVY-LOCK-SELF-WAIT: an unused reservation passes on (the agent that took it is told).
    let passed = false;
    for (const [agentId, r] of [...this.reservations.entries()]) {
      if (t < r.until) continue;
      this.reservations.delete(agentId);
      this.log({ kind: 'heavy-lock', action: 'reserve-expired', agentId, heavyKind: r.kind });
      this.changed();
      this.lapse(agentId, r.kind, 'expired');
      passed = true;
    }
    if (passed || left) this.grant();
  }

  /** The watcher runs only while a slot is held or reserved: TTL and reservation expiry, and a
   *  process check for background holders (a hidden listing every HEAVY_SCAN_MS). */
  private arm(): void {
    if (this.timer || !this.watching()) return;
    this.timer = this.setTimer(() => { this.timer = null; void this.scan().finally(() => this.arm()); }, HEAVY_SCAN_MS);
  }

  /** One watcher tick (exported for tests). */
  async scan(): Promise<void> {
    this.expire();
    // Jim MF1 / god andyheavyfix: EVERY holder is checked, not only background ones: a foreground
    // call whose PostToolUse never comes (a gate, Esc, a timeout, a degraded Codex hook) must not
    // pin a slot for the whole TTL. The listing runs only while a slot is held. A miss counts only
    // once the holder is at least one scan interval old (its job has had time to start).
    const held = [...this.holders.values()];
    const leaseWork = this.leases.size > 0 || this.waiters.some((w) => w.procs.length > 0) || [...this.reservations.values()].some((r) => r.procs.length > 0);
    if (!this.d.probe || ((!held.length || !this.d.roots) && !leaseWork)) return;
    let procs: ProcRow[] | null;
    try { procs = await this.d.probe(); } catch { procs = null; }
    this.sweepLeases(procs);
    if (!held.length || !this.d.roots) return;
    const probed = await this.heavyAgents({ procs });
    if (!probed) return;   // Jim MF4: unknown, not a miss
    const { busy, seen } = probed;
    const t = this.now();
    for (const h of held) {
      if (!this.holders.has(h.agentId)) continue;
      if (busy.has(h.agentId)) { h.misses = 0; h.seenRunning = true; continue; }
      if (!seen.has(h.agentId)) continue;   // its PTY root is not in the listing: unknown, not a miss
      h.seenRunning = false;
      if (t - h.touched < HEAVY_SCAN_MS) continue;
      h.misses++;
      // No heavy process of the holder on HEAVY_SCAN_MISSES scans: its job is gone, whatever the
      // call bookkeeping says (an open call here is one whose PostToolUse never came).
      if (h.misses >= HEAVY_SCAN_MISSES) { h.calls.clear(); this.release(h.agentId, 'process-exit'); }
    }
  }

  /** HEAVY-LOCK-OPAQUE-SCRIPT-196: PreToolUse of any call. One that IS a `node --test` of named files
   *  may make the one test process it starts VISIBLE (light). */
  noteCall(agentId: string, callId: string, command: string): void {
    // A run with no files is node's own discovery (a suite): never VISIBLE.
    const runs = (testInvocation(command) ?? []).filter((files) => files.length);
    if (!runs.length) return;
    const t = this.now();
    const list = (this.testCalls.get(agentId) ?? []).filter((c) => this.callOpen(c, t));
    for (const files of runs) list.push({ callId, files: files.map(normFile), start: t, end: null, used: false });
    this.testCalls.set(agentId, list.slice(-16));
  }

  /** PostToolUse: the call's window closes (a test process may still report for HEAVY_CALL_SLACK_MS). */
  noteCallEnd(agentId: string, callId: string): void {
    const t = this.now();
    for (const c of this.testCalls.get(agentId) ?? []) if (c.callId === callId && c.end === null) c.end = t;
  }

  private callOpen(c: { start: number; end: number | null; files?: string[] }, t: number): boolean {
    // A loop's run (`node --test test/$f.test.cjs`) starts its processes all through the call, so it
    // matches while the call is open (bounded, if its PostToolUse never comes).
    if (c.files?.length === 1 && c.files[0] === ANY_TEST_FILE) return c.end === null && t - c.start <= HEAVY_LOOP_CALL_MS;
    return t - c.start <= HEAVY_CALL_SPAWN_MS && (c.end === null || t - c.end <= HEAVY_CALL_SLACK_MS);
  }

  /**
   * HEAVY-LOCK-OPAQUE-SCRIPT-196: a test process asks (the preload, before any test runs).
   *  - Part of a classified run (GUPPY_TEST_RUN names a LIVE run of this agent; Jim MUST B): it
   *    inherits that run's class. It grants nothing on its own: the run is checked live.
   *  - VISIBLE (the call's own `node --test` of exactly these files, its parent the call's shell; Jim
   *    MUST A): the PreToolUse classifier already judged it, so it is light (or shares the agent's slot).
   *  - Otherwise (an opaque wrapper started it, or it is a suite runner): a heavy job. It takes a slot,
   *    shares its agent's, or WAITS in the queue (a long poll; the preload asks again).
   */
  async lease(agentId: string, r: HeavyLeaseRequest, gone?: () => boolean): Promise<HeavyLeaseAnswer> {
    if (r.op === 'release') { this.leaseEnd(agentId, String(r.leaseId ?? ''), 'released'); return { state: 'released' }; }
    if (r.op === 'unreserve') return this.unreserve(agentId, typeof r.to === 'string' ? r.to : undefined);
    if (r.op === 'status') {
      const q = this.queueSnapshot();
      return { state: 'status', holders: [...this.holders.keys()], waiters: q.waiters.map((w) => w.agentId), reserved: q.reserved.map((x) => ({ agentId: x.agentId, until: x.until })) };
    }
    const pid = Number(r.pid);
    const createdMs = Math.round(Number(r.createdMs));
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(createdMs)) throw new Error('a lease needs pid and createdMs');
    const run = `${pid}:${createdMs}`;
    this.pruneRuns();
    const parent = typeof r.parentRun === 'string' ? this.runs.get(r.parentRun) : undefined;
    if (parent && parent.agentId === agentId && this.runAlive(r.parentRun!)) {
      const held = parent.held && this.holders.has(agentId);
      this.runs.set(run, { agentId, held });
      this.log({ kind: 'heavy-lock', action: 'lease-inherit', agentId, pid, held });
      return held ? { state: 'held', run, leaseId: null, why: 'part of a held run' } : { state: 'light', run, why: 'part of a light run' };
    }
    // A suite runner is judged by its own argv, as PreToolUse judges it: a filtered run
    // (`run-tests.cjs wake`) is light, whoever started it.
    let suite = r.suite === true;
    if (Array.isArray(r.runner)) {
      const argv = ['node', ...r.runner.map(String)].map((a) => `"${a.replace(/["\\$`]/g, '\\$&')}"`).join(' ');
      if (!classifyCommand(argv).heavy) {
        this.runs.set(run, { agentId, held: this.holders.has(agentId) });
        return { state: 'light', run, why: 'a filtered suite runner' };
      }
      suite = true;
    }
    if (!suite && await this.visible(agentId, r)) {
      this.runs.set(run, { agentId, held: this.holders.has(agentId) });
      return { state: 'light', run, why: "the call's own node --test" };
    }
    const kind: HeavyKind = suite ? 'suite' : 'bench';
    const cls: HeavyClass = { heavy: true, kind, why: suite ? 'a suite run (heavy preload)' : 'a node --test its call does not show (heavy preload)' };
    const id = `lease:${run}`;
    const deadline = this.now() + (this.d.leasePollMs ?? HEAVY_LEASE_POLL_MS);
    for (;;) {
      // A waiting process asks again only when a slot may be its own (no deny row every poll).
      const queued = this.waiters.find((w) => w.agentId === agentId && w.procs.some((p) => p.pid === pid));
      const limit = this.d.limit();
      // HEAVY-SLOT-EXCLUSIVE-192: a lease is a suite or a bench, so it fits only an empty machine.
      const full = limit !== 'off' && !this.fits(agentId, heavyExclusive(cls), limit);
      if (!(queued && full && !this.reservations.has(agentId) && !this.holders.has(agentId))) {
        const shared = this.holders.has(agentId);
        const d = this.acquire(agentId, cls, `node --test (pid ${pid})`, id, false);
        if (d.allow) {
          // 'off' (or nothing held after all): nothing to release.
          if (!this.holders.get(agentId)?.calls.has(id)) { this.runs.set(run, { agentId, held: false }); return { state: 'light', run, why: 'heavy jobs are unlimited' }; }
          this.leases.set(id, { agentId, pid, createdMs, run });
          this.runs.set(run, { agentId, held: true });
          const mine = [...this.leases.values()].filter((l) => l.agentId === agentId).length;
          this.log({ kind: 'heavy-lock', action: 'lease', agentId, heavyKind: kind, pid, shared });
          // Jim SHOULD 3: two heavy jobs of one agent on its one slot (today's share semantics).
          if (mine > 1) this.log({ kind: 'heavy-lock', action: 'shared-concurrent', agentId, leases: mine });
          this.arm();
          return { state: 'held', run, leaseId: id, why: cls.why! };
        }
        const w = this.waiters.find((x) => x.agentId === agentId);
        this.arm();
        // The first answer to a newly queued process is at once, so it can say it waits; later ones long-poll.
        if (w && !w.procs.some((p) => p.pid === pid)) {
          w.procs.push({ pid, createdMs });
          return { state: 'wait', position: this.waiters.indexOf(w) + 1, holders: [...this.holders.keys()] };
        }
      } else queued.since = this.now();
      const left = deadline - this.now();
      if (left <= 0 || gone?.() || !(await this.waitFor(left, () => this.reservations.has(agentId) || !!gone?.())) || gone?.()) {
        const position = this.waiters.findIndex((x) => x.agentId === agentId) + 1;
        return { state: 'wait', position, holders: [...this.holders.keys()] };
      }
    }
  }

  /** Resolve true as soon as `ok()` holds after a change, false after `ms`. */
  private waitFor(ms: number, ok: () => boolean): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: boolean): void => { if (done) return; done = true; off(); this.clearTimer(timer); resolve(v); };
      const off = this.onChange(() => { if (ok()) finish(true); });
      const timer = this.setTimer(() => finish(false), ms);
    });
  }

  /** A lease ends: the preload released it at exit, or the scan found its process gone. */
  private leaseEnd(agentId: string, id: string, reason: 'released' | 'gone'): void {
    const l = this.leases.get(id);
    if (!l || l.agentId !== agentId) return;
    this.leases.delete(id);
    this.runs.delete(l.run);
    this.log({ kind: 'heavy-lock', action: reason === 'gone' ? 'lease-gone' : 'lease-end', agentId, pid: l.pid });
    this.callDone(agentId, id);
  }

  /** Jim MUST A: the test files match a recent call of this agent that IS that run, unused, and the
   *  test process's parent is the call's shell. Consumed once. */
  private async visible(agentId: string, r: HeavyLeaseRequest): Promise<boolean> {
    const files = Array.isArray(r.files) ? r.files.filter((f): f is string => typeof f === 'string').map(normFile) : [];
    if (!files.length) return false;
    const t = this.now();
    // Jim MUST 1 (b): a loop's run matches any single-file process while its call is open, never consumed.
    const loop = (c: { files: string[] }): boolean => c.files.length === 1 && c.files[0] === ANY_TEST_FILE && files.length === 1;
    const match = (): { used: boolean; files: string[] } | undefined => (this.testCalls.get(agentId) ?? []).find((c) => this.callOpen(c, t)
      && (loop(c) || (!c.used && c.files.length === files.length && c.files.every((f, i) => f === files[i]))));
    if (!match() || !this.d.parentImage || typeof r.ppid !== 'number') return false;
    let image: string | null;
    try { image = await this.d.parentImage(r.ppid); } catch { image = null; }
    const name = (image ?? '').replace(/\\/g, '/').split('/').pop()!;
    if (!CALL_PARENT.test(name)) { this.log({ kind: 'heavy-lock', action: 'lease-not-own', agentId, parent: image }); return false; }
    const c = match();
    if (!c) return false;
    if (!loop(c)) c.used = true;
    return true;
  }

  private runAlive(run: string): boolean {
    const pid = Number(run.split(':')[0]);
    try { return this.d.pidAlive ? this.d.pidAlive(pid) : pidRunning(pid); } catch { return false; }
  }

  /** Runs whose process has exited are forgotten (a light run never says it ended). */
  private pruneRuns(): void {
    if (this.runs.size < 64) return;
    for (const run of [...this.runs.keys()]) if (!this.runAlive(run)) this.runs.delete(run);
  }

  /** One listing (the scan's): leases and runs whose process is gone end; a test process that died
   *  waiting leaves the queue, and a slot reserved for it passes on (Jim MUST C). A failed listing
   *  is unknown: nothing changes. */
  private sweepLeases(procs: ProcRow[] | null): void {
    if (!procs || !procs.length || !procs.some((p) => typeof p.createdMs === 'number')) return;
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    for (const [id, l] of [...this.leases]) if (!procLive(byPid, l.pid, l.createdMs)) this.leaseEnd(l.agentId, id, 'gone');
    for (const run of [...this.runs.keys()]) { const [pid, created] = run.split(':').map(Number); if (!procLive(byPid, pid, created)) this.runs.delete(run); }
    let waiterLeft = false;
    for (const w of [...this.waiters]) {
      if (!w.procs.length) continue;
      w.procs = w.procs.filter((p) => procLive(byPid, p.pid, p.createdMs));
      if (w.procs.length || w.hooked) continue;
      this.dequeue(w.agentId);
      this.log({ kind: 'heavy-lock', action: 'queue-dropped', agentId: w.agentId, reason: 'waiter-gone' });
      this.changed();
      // HEAVY-SLOT-EXCLUSIVE-192: it may have been an exclusive head holding the others back.
      waiterLeft = true;
    }
    let freed = waiterLeft;
    for (const [agentId, r] of [...this.reservations]) {
      if (!r.procs.length) continue;
      r.procs = r.procs.filter((p) => procLive(byPid, p.pid, p.createdMs));
      if (r.procs.length || r.hooked) continue;
      this.reservations.delete(agentId);
      this.log({ kind: 'heavy-lock', action: 'reserve-dropped', agentId, reason: 'waiter-gone' });
      this.changed();
      freed = true;
    }
    if (freed) this.grant();
  }

  private log(row: Record<string, unknown>): void { try { this.d.log?.(row); } catch { /* best effort */ } }
}

/** The listing script: one hidden, non-interactive PowerShell CIM query. CreationDate goes out as
 *  epoch ms under the `CreatedMs` alias (PowerShell 5.1 would serialise a DateTime as /Date(...)/). */
export const PROCESS_LISTING_SCRIPT = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,@{n='CreatedMs';e={ if ($_.CreationDate) { [int64](($_.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds) } else { $null } }} | ConvertTo-Json -Compress";

/** Parse the listing's ConvertTo-Json output (an array, or one bare object). null = unusable
 *  (empty, unparseable, or no row carries a numeric CreatedMs): the watcher then counts no miss. */
export function parseProcessListing(stdout: string): ProcRow[] | null {
  if (!stdout || !stdout.trim()) return null;
  let raw: unknown;
  try { raw = JSON.parse(stdout); } catch { return null; }
  const rows = (Array.isArray(raw) ? raw : [raw]) as Array<{ ProcessId?: unknown; ParentProcessId?: unknown; CommandLine?: unknown; CreatedMs?: unknown } | null>;
  const out = rows.filter((r) => r && Number.isInteger(r.ProcessId)).map((r) => ({ pid: r!.ProcessId as number, parentPid: Number(r!.ParentProcessId), commandLine: typeof r!.CommandLine === 'string' ? r!.CommandLine : '', ...(typeof r!.CreatedMs === 'number' ? { createdMs: r!.CreatedMs } : {}) }));
  return out.length && out.some((p) => typeof p.createdMs === 'number') ? out : null;
}

/** The default process listing (Windows only; null when it fails or times out). */
export function probeProcesses(): Promise<ProcRow[] | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PROCESS_LISTING_SCRIPT], { windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
    resolve(err ? null : parseProcessListing(String(stdout)));
  }));
}

/** HEAVY-LOCK-OPAQUE-SCRIPT-196: is `pid` listed with this creation time (within the clock skew)? */
function procLive(byPid: Map<number, ProcRow>, pid: number, createdMs: number): boolean {
  const p = byPid.get(pid);
  return !!p && typeof p.createdMs === 'number' && Math.abs(p.createdMs - createdMs) <= HEAVY_CREATED_SKEW_MS;
}

/** Is `pid` running? (EPERM: it is, as another user's.) */
export function pidRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** HEAVY-LOCK-OPAQUE-SCRIPT-196: the image name of one process (a test process's parent), or null.
 *  tasklist, not the CIM listing: it answers in ~0.1 s and runs once per single-file test run. */
export function processImage(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(null);
  const [cmd, args] = process.platform === 'win32'
    ? ['tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']]
    : ['ps', ['-o', 'comm=', '-p', String(pid)]];
  return new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 5_000 }, (err, stdout) => {
    if (err) { resolve(null); return; }
    const out = String(stdout).trim();
    if (process.platform !== 'win32') { resolve(out || null); return; }
    const m = /^"([^"]+)","(\d+)"/.exec(out);
    resolve(m && Number(m[2]) === pid ? m[1] : null);
  }));
}
