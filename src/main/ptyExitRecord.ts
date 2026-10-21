/**
 * ANDY-PTY-EXIT-2049 (design to god, GO 05:39Z): an UNREQUESTED PTY exit leaves enough evidence to
 * name its cause. Two self-exits (Andy 10-01 20:49:58Z, Dwight 10-21 04:58:40Z, both exit 0) could
 * not be explained because nothing of the terminal, the tool call or the CLI's own log was kept.
 *
 * On a non-explicit end (pty.ts hands over its mirror and raw tail), main collects, fire-and-forget:
 *  - the exit: code, signal, the code decoded, pid, uptime;
 *  - the screen: the mirror's last rows (read within EXIT_MIRROR_READ_MS) and the raw output tail,
 *    ANSI-stripped. Through ConPTY the CLI's stderr IS this stream: no separate stderr exists;
 *  - hooks and tools: the last hook (time + event), the call in flight, the agent's heavy lock;
 *  - children still alive: processes whose parent is in the CLI's tree and created after it
 *    (own-procs rule, never a stranger with a recycled parent pid). A dead middle process hides
 *    its subtree: the listing cannot walk through it;
 *  - the transcript's last rows, its path, mtime AND last row's own time (Windows does not move the
 *    mtime of a file its writer holds open: Dwight's rollout read 10-19 while its rows ran to 10-21),
 *    and the last tool call with whether its output arrived (Dwight's: wait_agent, none);
 *  - Codex: the last rows of <CODEX_HOME>/logs_2.sqlite for that process, read-only, no busy wait.
 * Written to <hive>/exits/<agentId>/<iso>-<incarnation>.json (main-only, never read back), capped at
 * EXIT_RECORD_MAX_BYTES, the newest EXIT_RECORDS_KEPT per agent kept; one small 'pty-exit-record'
 * row goes to the hive log. Every reader fails soft: a missing part is named, never thrown.
 */
import { closeSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MirrorReading } from './terminalMirror';
import type { ProcRow } from './heavyJob';

export const EXIT_RECORD_MAX_BYTES = 64 * 1024;
export const EXIT_RECORDS_KEPT = 20;
export const EXIT_SCREEN_ROWS = 40;
export const EXIT_RAW_TAIL_CHARS = 4096;
export const EXIT_FIELD_CHARS = 200;
export const EXIT_CODEX_ROLLOUT_ROWS = 20;
export const EXIT_CLAUDE_TRANSCRIPT_ROWS = 10;
export const EXIT_CODEX_LOG_ROWS = 30;
export const EXIT_MIRROR_READ_MS = 1500;
export const EXIT_PROCESS_LIST_MS = 3000;
/** How much of a transcript's end is read for its last rows (a row can be a long tool output). */
export const EXIT_TRANSCRIPT_READ_BYTES = 512 * 1024;

const clip = (s: unknown, n = EXIT_FIELD_CHARS): string => {
  const t = typeof s === 'string' ? s : s === undefined ? '' : JSON.stringify(s) ?? '';
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** What an exit code says. Windows NTSTATUS codes arrive signed or unsigned. */
export function decodeExitCode(code: number | null, signal?: number | null): string {
  if (typeof signal === 'number' && signal > 0) return `signal ${signal}`;
  if (code === null) return 'unknown (no exit code)';
  const u = code >>> 0;
  const hex = `0x${u.toString(16).toUpperCase().padStart(8, '0')}`;
  const known: Record<number, string> = {
    0: 'the CLI exited by itself (clean exit)',
    1: 'exit 1: an error exit, or TerminateProcess / taskkill /F',
    0xC0000005: 'access violation (crash)',
    0xC0000409: 'fail-fast / abort (stack buffer overrun, panic=abort)',
    0xC000013A: 'Ctrl+C (STATUS_CONTROL_C_EXIT)',
    0xC00000FD: 'stack overflow (crash)',
    0xC0000017: 'out of memory (STATUS_NO_MEMORY)',
    0xE0434352: '.NET unhandled exception',
    0x40010004: 'killed by a debugger / DBG_TERMINATE_PROCESS'
  };
  return known[u] ?? (u >= 0xC0000000 ? `NTSTATUS ${hex} (a crash)` : `exit ${code}`);
}

/** The text of terminal output: CSI/OSC/other escapes and stray controls removed. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

export interface TranscriptRow { at: string | null; type: string; kind: string; name?: string; text: string }
export interface TranscriptCall { at: string | null; name: string; args: string; hasOutput: boolean }
export interface TranscriptTail {
  file: string;
  mtimeMs: number | null;
  bytes: number | null;
  /** The newest row's own timestamp: the freshness fact (never the mtime). */
  lastRowAt: string | null;
  rows: TranscriptRow[];
  lastCall: TranscriptCall | null;
  error?: string;
}

/** PURE: the last `n` rows of a Codex rollout or Claude transcript text, and its last tool call. */
export function transcriptTail(text: string, provider: 'codex' | 'claude', n: number): Omit<TranscriptTail, 'file' | 'mtimeMs' | 'bytes'> {
  const parsed: Array<Record<string, any>> = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && typeof r === 'object') parsed.push(r); } catch { /* the first line of a tail is partial */ }
  }
  const at = (r: Record<string, any>): string | null => (typeof r.timestamp === 'string' ? r.timestamp : null);
  const rows: TranscriptRow[] = []; let lastCall: TranscriptCall | null = null; const answered = new Set<string>();
  for (const r of parsed) {
    if (provider === 'codex') {
      const p = (r.payload ?? {}) as Record<string, any>;
      const kind = typeof p.type === 'string' ? p.type : '';
      if (/_call_output$/.test(kind) && typeof p.call_id === 'string') answered.add(p.call_id);
      if (kind === 'function_call' || kind === 'custom_tool_call' || kind === 'local_shell_call') {
        lastCall = { at: at(r), name: clip(p.name ?? kind, 80), args: clip(p.arguments ?? p.input ?? p.action), hasOutput: false, ...(typeof p.call_id === 'string' ? { id: p.call_id } : {}) } as TranscriptCall;
      }
      rows.push({ at: at(r), type: String(r.type ?? ''), kind, ...(p.name ? { name: clip(p.name, 80) } : {}), text: clip(p.arguments ?? p.input ?? p.output ?? p.message ?? p.text ?? '') });
    } else {
      const m = (r.message ?? {}) as Record<string, any>;
      const content = Array.isArray(m.content) ? m.content as Array<Record<string, any>> : [];
      for (const c of content) {
        if (c.type === 'tool_result' && typeof c.tool_use_id === 'string') answered.add(c.tool_use_id);
        if (c.type === 'tool_use') lastCall = { at: at(r), name: clip(c.name, 80), args: clip(c.input), hasOutput: false, ...(typeof c.id === 'string' ? { id: c.id } : {}) } as TranscriptCall;
      }
      const kinds = content.map((c) => String(c.type)).join(',') || (typeof m.content === 'string' ? 'text' : '');
      const tool = content.find((c) => c.type === 'tool_use');
      const text = content.map((c) => (c.type === 'text' ? c.text : c.type === 'tool_use' ? c.input : c.type === 'tool_result' ? c.content : '')).find((x) => x) ?? m.content ?? '';
      rows.push({ at: at(r), type: String(r.type ?? ''), kind: m.stop_reason ? `${kinds} stop=${m.stop_reason}` : kinds, ...(tool ? { name: clip(tool.name, 80) } : {}), text: clip(text) });
    }
  }
  if (lastCall) {
    const id = (lastCall as TranscriptCall & { id?: string }).id;
    lastCall = { at: lastCall.at, name: lastCall.name, args: lastCall.args, hasOutput: !!id && answered.has(id) };
  }
  const tail = rows.slice(-n);
  const lastRowAt = [...parsed].reverse().map(at).find((x) => x) ?? null;
  return { lastRowAt, rows: tail, lastCall };
}

/** The end of a transcript file: its last rows, path, mtime, size. Never throws. */
export function readTranscriptTail(file: string, provider: 'codex' | 'claude', n: number): TranscriptTail {
  let mtimeMs: number | null = null; let bytes: number | null = null;
  try {
    const st = statSync(file); mtimeMs = st.mtimeMs; bytes = st.size;
    const len = Math.min(st.size, EXIT_TRANSCRIPT_READ_BYTES);
    const buf = Buffer.alloc(len);
    const fd = openSync(file, 'r');
    try { readSync(fd, buf, 0, len, st.size - len); } finally { closeSync(fd); }
    return { file, mtimeMs, bytes, ...transcriptTail(buf.toString('utf8'), provider, n) };
  } catch (e) {
    return { file, mtimeMs, bytes, lastRowAt: null, rows: [], lastCall: null, error: clip(e instanceof Error ? e.message : String(e)) };
  }
}

export interface CodexLogRow { ts: number; level: string; target: string; body: string }
export interface CodexLogTail { file: string; process: string | null; match: 'pid' | 'window' | 'none'; rows: CodexLogRow[]; error?: string }
/** The slice of better-sqlite3 used here (injected: tests use a fake, main the real driver). */
export interface SqliteLike { prepare(sql: string): { all(...args: unknown[]): unknown[] }; close(): void }

/**
 * The last rows Codex logged for the exited process, from <codexHome>/logs_2.sqlite. Its
 * process_uuid is `pid:<pid>:<uuid>`; the PTY's pid can be a shim's, so when no row carries it, the
 * process whose rows fall inside this incarnation's life (spawn - 60 s .. exit + 5 s) and logged
 * last is taken, and the record says which rule matched. Read-only, no busy wait; any error skips.
 */
export function readCodexLogTail(codexHome: string, pids: number[], spawnedAt: number | null, exitAt: number, n: number, open: (file: string) => SqliteLike): CodexLogTail {
  const file = join(codexHome, 'logs_2.sqlite');
  let db: SqliteLike | null = null;
  try {
    db = open(file);
    const procs = db.prepare('SELECT process_uuid AS p, MIN(ts) AS lo, MAX(ts) AS hi FROM logs WHERE ts >= ? GROUP BY process_uuid')
      .all(Math.floor(((spawnedAt ?? exitAt) - 60_000) / 1000)) as Array<{ p: string; lo: number; hi: number }>;
    let pick = procs.find((r) => pids.some((pid) => r.p.startsWith(`pid:${pid}:`)));
    let match: CodexLogTail['match'] = pick ? 'pid' : 'none';
    if (!pick) {
      const inLife = procs.filter((r) => r.hi <= Math.ceil(exitAt / 1000) + 5).sort((a, b) => b.hi - a.hi);
      if (inLife.length) { pick = inLife[0]; match = 'window'; }
    }
    if (!pick) return { file, process: null, match, rows: [] };
    const rows = (db.prepare('SELECT ts, level, target, substr(feedback_log_body, 1, 400) AS body FROM logs WHERE process_uuid = ? ORDER BY ts DESC, ts_nanos DESC LIMIT ?')
      .all(pick.p, n) as Array<{ ts: number; level: string; target: string; body: string | null }>)
      .reverse().map((r) => ({ ts: r.ts, level: String(r.level), target: clip(r.target, 80), body: clip(r.body ?? '') }));
    return { file, process: pick.p, match, rows };
  } catch (e) {
    return { file, process: null, match: 'none', rows: [], error: clip(e instanceof Error ? e.message : String(e)) };
  } finally {
    try { db?.close(); } catch { /* closed */ }
  }
}

export interface ExitChild { pid: number; parentPid: number; createdMs: number | null; commandLine: string }
/**
 * PURE: the processes still alive in the exited CLI's tree. A child counts only if its parent is
 * the root (or a counted child) AND it was created after that parent (own-procs: a recycled
 * parent pid never adopts a stranger).
 */
export function childrenAtExit(rows: ProcRow[], rootPid: number, rootCreatedMs: number): ExitChild[] {
  const born = new Map<number, number>([[rootPid, rootCreatedMs]]);
  const out: ExitChild[] = [];
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows) {
      if (born.has(r.pid)) continue;
      const parentBorn = born.get(r.parentPid);
      if (parentBorn === undefined || typeof r.createdMs !== 'number' || r.createdMs < parentBorn) continue;
      born.set(r.pid, r.createdMs); grew = true;
      out.push({ pid: r.pid, parentPid: r.parentPid, createdMs: r.createdMs, commandLine: clip(r.commandLine) });
    }
  }
  return out;
}

export interface ExitFacts {
  agentId: string;
  ptyId: string;
  incarnation: number;
  provider: string;
  exitCode: number | null;
  signal: number | null;
  at: number;
  pid: number | null;
  spawnedAt: number | null;
  command: string;
  cwd: string;
  rawTail: string;
  lastHookAt: number | null;
  lastHookEvent: string | null;
  runningTool: { name: string; since: number } | null;
  heavyLock: unknown[];
}

export interface ExitParts {
  screen: MirrorReading | null;
  screenError?: string;
  children: ExitChild[] | null;
  childrenError?: string;
  transcript: TranscriptTail | null;
  codexLog: CodexLogTail | null;
}

/** PURE: the record, every part bounded; `truncated` names what the size cap cut. */
export function buildExitRecord(f: ExitFacts, p: ExitParts, maxBytes = EXIT_RECORD_MAX_BYTES): Record<string, unknown> {
  const screenRows = p.screen ? (() => { const l = [...p.screen.lines]; while (l.length && !l[l.length - 1].trim()) l.pop(); return l.slice(-EXIT_SCREEN_ROWS).map((x) => clip(x, 240)); })() : [];
  const rec: Record<string, any> = {
    kind: 'pty-exit-record',
    agentId: f.agentId, ptyId: f.ptyId, incarnation: f.incarnation, provider: f.provider,
    at: new Date(f.at).toISOString(),
    exit: { code: f.exitCode, signal: f.signal, decoded: decodeExitCode(f.exitCode, f.signal), pid: f.pid, uptimeMs: f.spawnedAt ? f.at - f.spawnedAt : null },
    command: clip(f.command, 400), cwd: f.cwd,
    hooks: {
      lastHookAt: f.lastHookAt ? new Date(f.lastHookAt).toISOString() : null,
      lastHookAgoMs: f.lastHookAt ? f.at - f.lastHookAt : null,
      lastHookEvent: f.lastHookEvent,
      runningTool: f.runningTool ? { name: f.runningTool.name, forMs: f.at - f.runningTool.since } : null
    },
    heavyLock: f.heavyLock,
    screen: { rows: screenRows, altScreen: p.screen?.altScreen ?? null, ...(p.screenError ? { error: p.screenError } : !p.screen ? { error: 'no mirror' } : {}) },
    rawTail: stripAnsi(f.rawTail).slice(-EXIT_RAW_TAIL_CHARS),
    stderr: 'through ConPTY the CLI\'s stderr is the terminal stream: see screen and rawTail',
    children: p.children ?? [], ...(p.childrenError ? { childrenError: p.childrenError } : {}),
    transcript: p.transcript, codexLog: p.codexLog,
    truncated: [] as string[]
  };
  // The cap: drop the bulkiest, least decisive parts first, each step named.
  const size = (): number => Buffer.byteLength(JSON.stringify(rec), 'utf8');
  const steps: Array<[string, () => void]> = [
    ['rawTail', () => { rec.rawTail = rec.rawTail.slice(-1024); }],
    ['children', () => { rec.children = rec.children.slice(0, 10); }],
    ['codexLog', () => { if (rec.codexLog) rec.codexLog.rows = rec.codexLog.rows.slice(-10); }],
    ['transcript', () => { if (rec.transcript) rec.transcript.rows = rec.transcript.rows.slice(-5); }],
    ['screen', () => { rec.screen.rows = rec.screen.rows.slice(-12); }],
    ['all', () => { rec.rawTail = ''; rec.children = []; if (rec.codexLog) rec.codexLog.rows = []; if (rec.transcript) rec.transcript.rows = []; }]
  ];
  for (const [name, cut] of steps) { if (size() <= maxBytes) break; cut(); rec.truncated.push(name); }
  return rec;
}

/** The hive log's one row for a record (small: the record holds the detail). */
export function exitLogRow(rec: Record<string, any>, file: string | null): Record<string, unknown> {
  return {
    kind: 'pty-exit-record', agentId: rec.agentId, incarnation: rec.incarnation, provider: rec.provider,
    exitCode: rec.exit?.code ?? null, decoded: rec.exit?.decoded, signal: rec.exit?.signal ?? null,
    lastHookEvent: rec.hooks?.lastHookEvent ?? null, runningTool: rec.hooks?.runningTool?.name ?? null,
    lastCall: rec.transcript?.lastCall ? `${rec.transcript.lastCall.name}${rec.transcript.lastCall.hasOutput ? '' : ' (no output)'}` : null,
    children: Array.isArray(rec.children) ? rec.children.length : 0,
    record: file
  };
}

/** Writes the record under <hive>/exits/<agentId>/ and keeps the newest `kept`. Returns its path. */
export function writeExitRecord(hiveRoot: string, rec: Record<string, any>, kept = EXIT_RECORDS_KEPT): string {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(String(rec.agentId))) throw new Error(`bad agent id: ${rec.agentId}`);
  const dir = join(hiveRoot, 'exits', rec.agentId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${String(rec.at).replace(/[:.]/g, '-')}-${rec.incarnation}.json`);
  writeFileSync(file, JSON.stringify(rec, null, 1));
  const all = readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  for (const old of all.slice(0, Math.max(0, all.length - kept))) { try { rmSync(join(dir, old), { force: true }); } catch { /* next write retries */ } }
  return file;
}

/** A promise's value within `ms`, else the fallback (the slow call is left to settle on its own). */
export function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms); t.unref?.();
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
  });
}

export interface ExitRecordDeps {
  hiveRoot: string;
  readScreen: (() => Promise<MirrorReading>) | null;
  disposeScreen: () => void;
  listProcesses: () => Promise<ProcRow[] | null>;
  transcript: () => { provider: 'codex' | 'claude'; file: string } | null;
  codexHome: string | null;
  openSqlite: (file: string) => SqliteLike;
  log: (row: Record<string, unknown>) => void;
}

/**
 * Collect and write one record. `facts` are taken by the caller SYNCHRONOUSLY at the end event
 * (teardown clears the hook and tool maps right after). Never throws; the mirror is always disposed.
 */
export async function recordExit(facts: ExitFacts, d: ExitRecordDeps): Promise<string | null> {
  const parts: ExitParts = { screen: null, children: null, transcript: null, codexLog: null };
  try {
    if (d.readScreen) {
      try { parts.screen = await within(d.readScreen(), EXIT_MIRROR_READ_MS, null as MirrorReading | null); if (!parts.screen) parts.screenError = `mirror read gave nothing within ${EXIT_MIRROR_READ_MS} ms`; }
      catch (e) { parts.screenError = clip(e instanceof Error ? e.message : String(e)); }
    }
  } finally {
    try { d.disposeScreen(); } catch { /* disposed */ }
  }
  try {
    if (facts.pid && facts.spawnedAt) {
      const rows = await within(d.listProcesses(), EXIT_PROCESS_LIST_MS, null);
      if (rows) parts.children = childrenAtExit(rows, facts.pid, facts.spawnedAt - 5_000);
      else parts.childrenError = `no process listing within ${EXIT_PROCESS_LIST_MS} ms`;
    } else parts.childrenError = 'no pid';
    const t = d.transcript();
    if (t) parts.transcript = readTranscriptTail(t.file, t.provider, t.provider === 'codex' ? EXIT_CODEX_ROLLOUT_ROWS : EXIT_CLAUDE_TRANSCRIPT_ROWS);
    if (facts.provider === 'codex' && d.codexHome) {
      const pids = [facts.pid ?? -1, ...(parts.children ?? []).map((c) => c.pid)];
      parts.codexLog = readCodexLogTail(d.codexHome, pids, facts.spawnedAt, facts.at, EXIT_CODEX_LOG_ROWS, d.openSqlite);
    }
    const rec = buildExitRecord(facts, parts);
    let file: string | null = null;
    try { file = writeExitRecord(d.hiveRoot, rec); } catch (e) { rec.writeError = clip(e instanceof Error ? e.message : String(e)); }
    try { d.log(exitLogRow(rec, file)); } catch { /* the log is best effort */ }
    return file;
  } catch (e) {
    try { d.log({ kind: 'pty-exit-record', agentId: facts.agentId, incarnation: facts.incarnation, error: clip(e instanceof Error ? e.message : String(e)) }); } catch { /* best effort */ }
    return null;
  }
}
