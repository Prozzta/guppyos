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
export interface HeavyClass { heavy: boolean; kind?: HeavyKind; why?: string }

/** Command-shaped tool input (the same reading as DESKTOP-LAUNCH-GUARD's). */
export function commandFromToolInput(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const r = input as Record<string, unknown>;
  const v = r.command ?? r.cmd ?? r.script;
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
 * Split a command line into words, honouring simple quotes (not a full shell parser). The same
 * reading as before 1.1.77 (a word that STARTS with a quote is that quoted text; a quote inside a
 * word is a plain character), plus one thing: a `$(...)` is opaque, spaces and quotes included.
 */
function words(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"') {
      let w = '';
      let j = i + 1;
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length) { w += s[j] + s[j + 1]; j += 2; continue; }
        if (s[j] === '$' && s[j + 1] === '(') { const e = substEnd(s, j); w += s.slice(j, e); j = e; continue; }
        w += s[j]; j++;
      }
      if (j < s.length) { out.push(w); i = j + 1; continue; }
      // Unclosed: as the old regex, a plain non-space word starting AT the quote (read below).
    }
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j >= 0) { out.push(s.slice(i + 1, j)); i = j + 1; continue; }
    }
    let w = '';
    while (i < s.length && !/\s/.test(s[i])) {
      if (s[i] === '$' && s[i + 1] === '(') { const e = substEnd(s, i); w += s.slice(i, e); i = e; continue; }
      w += s[i]; i++;
    }
    out.push(w);
  }
  return out;
}

/** HEAVY-CLASSIFIER-FP: drop every heredoc BODY (`<<'EOF'` ... `EOF`). The body is data fed to
 *  stdin (a python/node edit script, a file's text), never commands this shell runs, so a line in
 *  it must not be classified. The `<<` line itself stays; the terminator line is dropped too. */
function stripHeredocs(cmd: string): string {
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
      if (q) { if (c === q && line[j - 1] !== '\\') q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
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
      while (i < lines.length && lines[i].trim() !== d) i++;
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
    const m = /^(\d*(?:>>?|<<?-?|<>)|&>>?)(&?)(.*)$/.exec(w);
    if (!m) { out.push(w); continue; }
    // Operator with its target attached (`>x.log`, `2>&1`, `<<EOF`): drop just this word.
    // A bare operator (`>`, `2>`, `<<`): its target is the next word; drop both.
    if (!m[3]) i++;
  }
  return out;
}

/** The segments a shell would run: split on ; && || | and newlines, OUTSIDE quotes. */
function segments(cmd: string): string[] {
  const out: string[] = [];
  let cur = ''; let q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    // HEAVY-JOB-LOCK-FAILOPEN: a command substitution is opaque (its pipes and quotes are its own).
    if (q !== "'" && c === '$' && cmd[i + 1] === '(') { const e = substEnd(cmd, i); cur += cmd.slice(i, e); i = e - 1; continue; }
    if (q) { cur += c; if (c === q && cmd[i - 1] !== '\\') q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    // HEAVY-CLASSIFIER-EDGES N2: an unquoted `#` at a word start comments out the rest of the line
    // (an apostrophe in a comment used to open a "quote" that swallowed the following lines).
    if (c === '#' && (i === 0 || /\s/.test(cmd[i - 1]))) { while (i + 1 < cmd.length && cmd[i + 1] !== '\n') i++; continue; }
    // A redirection's `&` (`2>&1`, `>&2`, `&>x`, `<&0`) is not a separator or a background `&`.
    if (c === '&' && (cmd[i - 1] === '>' || cmd[i - 1] === '<' || cmd[i + 1] === '>')) { cur += c; continue; }
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

const WRAPPERS = new Set(['bash', 'sh', 'zsh', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'bash.exe']);
/** The binaries a wrapper script can be asked to run (`node clean-run.cjs <bin> ...`). */
const WRAPPED_BINS = new Set(['node', 'npm', 'npx', 'pnpm', 'yarn', 'electron', 'electron-builder', 'electron-rebuild', 'node-gyp', 'vitest', 'env', 'timeout', 'nice']);
const BENCH_SCRIPT = /(mutant|mutation|replay|bench|backfill|parity|speed|stress|soak)[^\\/]*\.(c?m?js|ts)$/i;
export const SUITE_MANY_FILES = 20;
/** A whole-suite runner script (heavy when run with no filter). */
const SUITE_RUNNER = /(^|[\\/])(run-?tests?|test-?runner|run-?all(-?tests)?)\.[cm]?[jt]s$/i;
/** Jim MF2: an opt-in scale/bench gate in the env prefix (THREAD_VIEW_SCALE=1 node --test x) makes
 *  even a single test file a bench. */
const BENCH_ENV = /^[A-Z0-9_]*(SCALE|BENCH|STRESS|SOAK)[A-Z0-9_]*=(1|true|yes|on)$/i;
/** node flags that take their value as the NEXT argument (so that value is not a test file). */
const NODE_VALUE_FLAGS = new Set(['--test-name-pattern', '--test-skip-pattern', '--test-reporter', '--test-reporter-destination', '--test-concurrency', '--test-timeout', '--test-shard', '--import', '--require', '-r', '--loader', '--experimental-loader', '--env-file', '--conditions', '-C', '--input-type']);

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
    if (w === 'cd' || w === 'pushd') return []; // `cd x` alone is its own segment
    break;
  }
  return ws.slice(i);
}

/** HEAVY-LOCK-SCRIPT-WRAPPER: what the classifier may read besides the command line. */
export interface ClassifyCtx {
  /** The text of a script file the command runs (`bash suite.sh`, `./gate.sh`), resolved against the
   *  call's cwd and size-capped by the caller; null when unreadable. Absent = scripts are not read. */
  readScript?: (path: string, cd?: string) => string | null;
  /** The directory an earlier `cd X` segment of the same command moved to (relative paths then resolve there). */
  cd?: string;
}

/** A script file run by a shell (`bash x.sh`, `./x.sh`) is heavy when its TEXT runs a heavy command. */
function classifyScript(path: string, depth: number, ctx: ClassifyCtx): HeavyClass {
  if (!ctx.readScript || depth >= 2) return { heavy: false };
  let text: string | null = null;
  try { text = ctx.readScript(path, ctx.cd); } catch { text = null; }
  if (!text) return { heavy: false };
  const c = classifyCommand(text, depth + 1, ctx);
  return c.heavy ? { ...c, why: `${c.why ?? c.kind} (in ${path.replace(/\\/g, '/').split('/').pop()})` } : { heavy: false };
}

function classifyWords(ws0: string[], depth: number, ctx: ClassifyCtx = {}): HeavyClass {
  const ws = leading(ws0);
  if (!ws.length) return { heavy: false };
  // An opt-in scale/bench env gate before the command (Jim MF2).
  const prefix = ws0.slice(0, ws0.length - ws.length);
  const gate = prefix.find((w) => BENCH_ENV.test(w));
  if (gate) return { heavy: true, kind: 'bench', why: `${gate.split('=')[0]} (an opt-in bench gate)` };
  const bin = ws[0].replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.(exe|cmd)$/, '');
  const args = ws.slice(1);
  // One level of a shell wrapper: bash -c "...", cmd /c ..., powershell -Command ...
  if (WRAPPERS.has(bin) && depth === 0) {
    // -c (sh), /c /k (cmd; Git Bash spells it //c), -Command (PowerShell)
    const k = args.findIndex((a) => /^(-c|\/\/?c|\/\/?k|-command)$/i.test(a));
    if (k >= 0) return classifyCommand(args.slice(k + 1).join(' '), depth + 1, ctx);
    // HEAVY-LOCK-SCRIPT-WRAPPER: `bash suite.sh` / `sh ./gate.sh`: the script's own text decides.
    const script = /^(bash|sh|zsh|bash\.exe)$/.test(bin) ? args.find((a) => !a.startsWith('-')) : undefined;
    return script ? classifyScript(script, depth, ctx) : { heavy: false };
  }
  // A script run directly (`./suite.sh`, `scripts/gate.sh`).
  if (/\.(sh|bash)$/i.test(ws[0])) return classifyScript(ws[0], depth, ctx);
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
  if (bin === 'npx') return classifyWords(args.filter((a) => !a.startsWith('-')), depth, ctx);
  if (bin === 'electron-rebuild' || bin === 'node-gyp') return { heavy: true, kind: 'install', why: bin };
  if (bin === 'electron-builder') return { heavy: true, kind: 'build', why: bin };
  if (bin === 'electron-vite' && has('build')) return { heavy: true, kind: 'build', why: 'electron-vite build' };
  if (bin === 'vitest') {
    const files = args.filter((a) => !a.startsWith('-') && a !== 'run');
    if (!files.length) return { heavy: true, kind: 'suite', why: 'vitest (all)' };
    return { heavy: false };
  }
  if (bin === 'node' || bin === 'electron' || bin === 'munder difflin') {
    if (args.some((a) => a.startsWith('--native-memory-bench'))) return { heavy: true, kind: 'bench', why: 'native-memory bench' };
    if (args.includes('--test')) {
      // Positional args only: the value of a flag that takes one is not a test file.
      const files: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a.startsWith('-')) { if (NODE_VALUE_FLAGS.has(a)) i++; continue; }
        files.push(a);
      }
      if (!files.length) return { heavy: true, kind: 'suite', why: 'node --test (all)' };
      if (files.some((f) => /[*?]/.test(f) || !/\.[cm]?[jt]s$/.test(f))) return { heavy: true, kind: 'suite', why: 'node --test (a glob or a directory)' };
      if (files.length >= SUITE_MANY_FILES) return { heavy: true, kind: 'suite', why: `node --test (${files.length} files)` };
      return { heavy: false };
    }
    const script = args.find((a) => !a.startsWith('-'));
    if (script && BENCH_SCRIPT.test(script)) return { heavy: true, kind: 'bench', why: `node ${script.replace(/\\/g, '/').split('/').pop()}` };
    // Jim MF2: a whole-suite runner script with no filter argument is the suite.
    if (script && SUITE_RUNNER.test(script)) {
      const rest = args.slice(args.indexOf(script) + 1).filter((a) => !a.startsWith('-'));
      if (!rest.length) return { heavy: true, kind: 'suite', why: `node ${script.replace(/\\/g, '/').split('/').pop()} (no filter)` };
    }
    // HEAVY-JOB-LOCK-FAILOPEN (Andy 42b671): a wrapper SCRIPT that runs the command after it
    // (`node clean-run.cjs node test/tools/run-tests.cjs`): that command is classified too.
    if (script && depth < 2) {
      const after = args.slice(args.indexOf(script) + 1);
      const head = after[0]?.replace(/\\/g, '/').split('/').pop()?.toLowerCase().replace(/\.(exe|cmd)$/, '') ?? '';
      if (WRAPPED_BINS.has(head)) return classifyWords(after, depth + 1, ctx);
    }
    return { heavy: false };
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
  const text = stripHeredocs(cmd);
  let here = ctx;
  for (const seg of segments(text)) {
    const ws = stripRedirects(words(seg.replace(/\s&$/, '')));
    // HEAVY-LOCK-SCRIPT-WRAPPER: `cd X && bash suite.sh` reads X/suite.sh.
    if ((ws[0] === 'cd' || ws[0] === 'pushd') && ws[1] && !ws[1].startsWith('-')) {
      const to = ws[1];
      here = { ...here, cd: /^([A-Za-z]:[\\/]|[\\/]|~)/.test(to) || !here.cd ? to : `${here.cd.replace(/[\\/]+$/, '')}/${to}` };
      continue;
    }
    const c = classifyWords(ws, depth, here);
    if (c.heavy) return c;
  }
  // HEAVY-JOB-LOCK-FAILOPEN: a substitution is opaque to the segment split (its pipes are its own),
  // but it RUNS: `X="$(node test/tools/run-tests.cjs)"` is a suite.
  if (depth < 3) {
    for (const inner of substitutions(text)) {
      const c = classifyCommand(inner, depth + 1, ctx);
      if (c.heavy) return c;
    }
  }
  return { heavy: false };
}

/** Classify a tool call (any provider: the command-shaped input only). */
export function classifyHeavy(_toolName: string | undefined, input: unknown, ctx: ClassifyCtx = {}): HeavyClass {
  const cmd = commandFromToolInput(input);
  return cmd ? classifyCommand(cmd, 0, ctx) : { heavy: false };
}

/** HEAVY-LOCK-SCRIPT-WRAPPER: the largest script file the classifier reads. */
export const HEAVY_SCRIPT_MAX_BYTES = 256 * 1024;

/** A ClassifyCtx reading scripts relative to `cwd` (the tool call's), size-capped; null on any failure. */
export function scriptReaderFor(cwd: string | null | undefined, read: (absPath: string) => { size: number; text: () => string } | null): ClassifyCtx {
  return {
    readScript: (p: string, cd?: string): string | null => {
      const raw = p.replace(/^["']|["']$/g, '');
      if (!raw || raw.includes('$') || cd?.includes('$') || cd?.startsWith('~')) return null;
      const isAbs = (x: string): boolean => /^([A-Za-z]:[\\/]|[\\/])/.test(x);
      const base = cd ? (isAbs(cd) || !cwd ? cd : `${cwd.replace(/[\\/]+$/, '')}/${cd}`) : cwd;
      const abs = isAbs(raw) || !base ? raw : `${base.replace(/[\\/]+$/, '')}/${raw}`;
      const f = read(abs);
      if (!f || f.size > HEAVY_SCRIPT_MAX_BYTES) return null;
      return f.text();
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
  /** Is this agent still live (a PTY)? A gone waiter is skipped. Absent = every agent is live. */
  alive?: (agentId: string) => boolean;
}

export const HEAVY_TTL_MS = 60 * 60_000;
/** HEAVY-LOCK-SELF-WAIT: how long a freed slot is kept for the queued agent it was offered to.
 *  A waiter stays queued until it is offered a slot, acquires, its PTY is gone, or it was last
 *  denied HEAVY_TTL_MS ago (Andy N2: dropped as stale). */
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
  const body = `The heavy-job slot you were queued for is now reserved for you until ${at}. Run your ${kind} now if you still need it; if you do not run it by then, it passes to the next agent in the queue. No reply is needed.`;
  return { message: { to: agentId, act: 'inform', requires_reply: false, subject, body, wake: 'now' }, from: 'system', steer: `${subject}.` };
}

export type HeavyDecision ={ allow: true; acquired: boolean } | { allow: false; reason: string; holders: HeavyHolder[] };

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
  private readonly waiters: Array<{ agentId: string; kind: HeavyKind; since: number }> = [];
  private readonly reservations = new Map<string, { kind: HeavyKind; until: number }>();
  private timer: unknown = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private readonly d: HeavyLockDeps) {
    this.now = d.now ?? Date.now;
    this.setTimer = d.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t; });
    this.clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  }

  /** The current holders (fleet.json, the deny text, tests). Expired ones are released first.
   *  HEAVY-JOB-LOCK-FAILOPEN: with how long each has held the slot and what keeps it (so agents read
   *  fleet.json instead of polling the log). */
  snapshot(): Array<{ agentId: string; kind: HeavyKind; command: string; since: string; heldMs: number; background: boolean; openCalls: number; seenRunning: boolean; lastProbe: 'ok' | 'failed' | null }> {
    this.expire();
    const t = this.now();
    return [...this.holders.values()].map((h) => ({
      agentId: h.agentId, kind: h.kind, command: h.command, since: new Date(h.since).toISOString(), heldMs: t - h.since,
      background: h.background, openCalls: h.calls.size, seenRunning: h.seenRunning, lastProbe: h.lastProbe
    }));
  }

  /** PreToolUse: a heavy call from `agentId`. Take a slot, share the agent's own, or deny. */
  acquire(agentId: string, cls: HeavyClass, command: string, callId: string, background: boolean): HeavyDecision {
    const limit = this.d.limit();
    if (!cls.heavy || !cls.kind) return { allow: true, acquired: false };
    // Off: no limit, but the heavy call is still visible (god: log 'heavy (unlimited)').
    if (limit === 'off') { this.log({ kind: 'heavy-lock', action: 'unlimited', agentId, heavyKind: cls.kind, why: cls.why ?? null }); return { allow: true, acquired: false }; }
    this.expire();
    // A slot that is free while agents wait (the limit was raised) goes to them first. Andy N3: a
    // slot reserved here for the CALLER itself is taken at once below, so it is not notified.
    if (this.waiters.length) this.grant(agentId);
    const mine = this.holders.get(agentId);
    if (mine) {
      // Re-entrant: an agent's heavy calls share its one slot (and refresh its TTL).
      mine.calls.add(callId); mine.background = mine.background || background; mine.touched = this.now(); mine.misses = 0;
      mine.windows.push({ callId, start: this.now(), end: null });
      this.log({ kind: 'heavy-lock', action: 'reenter', agentId, heavyKind: cls.kind, command: command.slice(0, 200) });
      this.arm();
      return { allow: true, acquired: false };
    }
    // HEAVY-LOCK-SELF-WAIT: a slot reserved for THIS agent is its own; the others count as taken.
    const reserved = this.reservations.has(agentId);
    if (!reserved && this.holders.size + this.reservations.size >= limit) {
      const holders = [...this.holders.values()];
      const position = this.enqueue(agentId, cls.kind);
      const who = holders.map((h) => `${h.agentId} (${h.kind}: ${h.command.slice(0, 80)}, since ${new Date(h.since).toISOString().slice(11, 19)}Z)`).join('; ');
      const others = [...this.reservations.entries()].map(([a, r]) => `reserved for ${a} until ${new Date(r.until).toISOString().slice(11, 19)}Z`).join('; ');
      const held = holders.length ? `${holders.length === 1 ? 'it is' : 'they are'} held by ${who}` : 'no job is running';
      const reason = `Denied by HEAVY-JOB-LOCK: the machine allows ${limit} heavy job${limit === 1 ? '' : 's'} at once and ${held}${others ? ` (${others})` : ''}. You are QUEUED (position ${position}): when a slot frees it is reserved for you for ${Math.round(HEAVY_RESERVE_MS / 60_000)} min and you are told "HEAVY SLOT FREE". Do not retry this or a variant of it now, and do not poll for the slot: carry on with light work (single test files, reads, edits are not limited) until you are told.`;
      // Jim N3: the denied command's CLASS is logged, not the command itself.
      this.log({ kind: 'heavy-lock', action: 'deny', agentId, heavyKind: cls.kind, why: cls.why ?? null, holders: holders.map((h) => ({ agentId: h.agentId, kind: h.kind, since: new Date(h.since).toISOString() })), limit, position });
      return { allow: false, reason, holders };
    }
    if (reserved) this.reservations.delete(agentId);
    this.dequeue(agentId);
    this.holders.set(agentId, { agentId, kind: cls.kind, command: command.slice(0, 200), since: this.now(), touched: this.now(), calls: new Set([callId]), background, misses: 0, seenRunning: false, attributed: new Map(), windows: [{ callId, start: this.now(), end: null }], lastProbe: null });
    this.log({ kind: 'heavy-lock', action: 'acquire', agentId, heavyKind: cls.kind, command: command.slice(0, 200), background, limit, ...(reserved ? { reserved: true } : {}) });
    this.arm();
    return { allow: true, acquired: true };
  }

  /** The queue as fleet.json shows it (oldest first), with the open reservations. */
  queueSnapshot(): { waiters: Array<{ agentId: string; kind: HeavyKind; since: string; position: number }>; reserved: Array<{ agentId: string; kind: HeavyKind; until: string }> } {
    this.expire();
    return {
      waiters: this.waiters.map((w, i) => ({ agentId: w.agentId, kind: w.kind, since: new Date(w.since).toISOString(), position: i + 1 })),
      reserved: [...this.reservations.entries()].map(([agentId, r]) => ({ agentId, kind: r.kind, until: new Date(r.until).toISOString() }))
    };
  }

  /** Queue a denied agent once (FIFO); its 1-based position. */
  private enqueue(agentId: string, kind: HeavyKind): number {
    const i = this.waiters.findIndex((w) => w.agentId === agentId);
    // A re-deny keeps its place and shows the agent still wants the slot (the waiter TTL restarts).
    if (i >= 0) { this.waiters[i].since = this.now(); return i + 1; }
    this.waiters.push({ agentId, kind, since: this.now() });
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
    if (limit === 'off') { this.waiters.length = 0; this.reservations.clear(); return; }
    while (this.waiters.length && this.holders.size + this.reservations.size < limit) {
      const w = this.waiters.shift()!;
      if (this.d.alive && !this.d.alive(w.agentId)) { this.log({ kind: 'heavy-lock', action: 'queue-dropped', agentId: w.agentId, reason: 'gone' }); continue; }
      // Andy N2: a waiter not denied again within HEAVY_TTL_MS has most likely moved on; a slot
      // reserved for it would sit unused for HEAVY_RESERVE_MS.
      if (this.now() - w.since >= HEAVY_TTL_MS) { this.log({ kind: 'heavy-lock', action: 'queue-dropped', agentId: w.agentId, reason: 'stale' }); continue; }
      const until = this.now() + HEAVY_RESERVE_MS;
      this.reservations.set(w.agentId, { kind: w.kind, until });
      this.log({ kind: 'heavy-lock', action: 'reserve', agentId: w.agentId, heavyKind: w.kind, until: new Date(until).toISOString(), waitedMs: this.now() - w.since });
      if (w.agentId === caller) continue;
      try { this.d.notify?.(w.agentId, w.kind, until); } catch { /* best effort: the reservation stands */ }
    }
    this.arm();
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
        if (busy?.busy.has(agentId)) { cur.background = true; cur.seenRunning = true; this.log({ kind: 'heavy-lock', action: 'orphan-kept', agentId, heavyKind: cur.kind }); this.arm(); return; }
        // (a) FAIL CLOSED: a failed listing says nothing about the job (most likely a TIMEOUT on a
        // loaded machine, i.e. exactly when a second heavy job hurts most). Keep the slot as a
        // background holder; the watcher frees it on two clean scans without it, or the TTL.
        if (!busy) { cur.background = true; cur.lastProbe = 'failed'; this.log({ kind: 'heavy-lock', action: 'probe-failed-kept', agentId, heavyKind: cur.kind }); this.arm(); return; }
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
  private async heavyAgents(): Promise<{ busy: Set<string>; seen: Set<string> } | null> {
    if (!this.d.probe || !this.d.roots) return null;
    let procs: ProcRow[] | null;
    try { procs = await this.d.probe(); } catch { procs = null; }
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
    return { busy, seen: rootsSeen };
  }

  /** The holder's PTY exited: its jobs are gone with it. */
  agentGone(agentId: string): void {
    // HEAVY-LOCK-SELF-WAIT: a gone agent neither waits nor keeps a reservation.
    this.dequeue(agentId);
    const had = this.reservations.delete(agentId);
    if (had) this.log({ kind: 'heavy-lock', action: 'reserve-dropped', agentId, reason: 'pty-exit' });
    if (this.holders.has(agentId)) this.release(agentId, 'pty-exit');
    else if (had) this.grant();
  }

  private release(agentId: string, reason: 'posttool' | 'process-exit' | 'pty-exit' | 'ttl' | 'expired-still-running'): void {
    const h = this.holders.get(agentId);
    if (!h) return;
    this.holders.delete(agentId);
    this.log({ kind: 'heavy-lock', action: 'release', agentId, heavyKind: h.kind, reason, heldMs: this.now() - h.since });
    // HEAVY-LOCK-SELF-WAIT: the freed slot goes to the oldest waiter (reserved), not to whoever asks first.
    this.grant();
    if (!this.holders.size && !this.reservations.size && this.timer) { this.clearTimer(this.timer); this.timer = null; }
  }

  private expire(): void {
    const t = this.now();
    // Jim N5: a TTL expiry while the watcher last SAW the job running is logged distinctly.
    for (const h of [...this.holders.values()]) if (t - h.touched >= HEAVY_TTL_MS) this.release(h.agentId, h.seenRunning ? 'expired-still-running' : 'ttl');
    // HEAVY-LOCK-SELF-WAIT: an unused reservation passes on; a waiter never offered a slot in time is dropped.
    let passed = false;
    for (const [agentId, r] of [...this.reservations.entries()]) {
      if (t < r.until) continue;
      this.reservations.delete(agentId);
      this.log({ kind: 'heavy-lock', action: 'reserve-expired', agentId, heavyKind: r.kind });
      passed = true;
    }
    if (passed) this.grant();
  }

  /** The watcher runs only while a slot is held or reserved: TTL and reservation expiry, and a
   *  process check for background holders (a hidden listing every HEAVY_SCAN_MS). */
  private arm(): void {
    if (this.timer || (!this.holders.size && !this.reservations.size)) return;
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
    if (!held.length || !this.d.probe || !this.d.roots) return;
    const probed = await this.heavyAgents();
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
