import { closeSync, cpSync, existsSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, statSync, type FSWatcher } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estimateCostUsd, normalizeModel } from './pricing';
import { watchDirectorySafely } from './safeDirectoryWatch';
// Type-only on purpose: this module is compiled standalone by test/transcript-usage,
// so it takes no runtime import beyond node, ./pricing and ./safeDirectoryWatch.
import type { AgentProvider } from '../shared/agentProvider';

/**
 * START-FIXES-163 (2), the Human's rule: an agent that is not a Claude agent NEVER
 * reads Claude transcripts, on any path. Every per-agent reader below takes the
 * agent's provider and refuses before touching the disk unless it is exactly
 * 'claude' — so a new provider is excluded by default, not by remembering to add
 * it to a list. (A registry entry with no provider is a legacy CLAUDE agent — the
 * spawn path treats it as one — and callers resolve that to 'claude' themselves.)
 *
 * Why it matters: a Codex or AGY agent's session id can never match a Claude
 * record, yet the usage fallback parsed every transcript in its cwd looking for
 * one — all 546 MB of C:/PrzEdit, twice, on the first 30 s beat of every start
 * (WHY-162 chain 1, the ~5 s main-process freeze).
 */
export function mayReadClaudeTranscripts(provider: AgentProvider | undefined | null): boolean {
  return provider === 'claude'; // same test as isClaudeProvider (shared/agentProvider)
}

/** Test seam: counts every per-agent transcript read that got past the provider gate. */
export const transcriptReadStats = { usageDirScans: 0, contextReads: 0 };

/** Claude Code's project key: the absolute cwd with EVERY non-alphanumeric
 *  character turned into a dash — the leading slash and any dots included.
 *  /Users/me/app → -Users-me-app, /Users/me/MDv0.3.0 → -Users-me-MDv0-3-0,
 *  C:\Users\me\app → C--Users-me-app.
 *
 *  One rule for every platform. The Windows branch always used it; POSIX had its
 *  own narrower spelling, and that divergence is what broke — see projectDir. */
function projectKey(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** The pre-2026 POSIX key: leading slash DROPPED, only slashes dashed, so dots
 *  survived (/Users/me/MDv0.3.0 → Users-me-MDv0.3.0). Kept solely so transcripts
 *  written before the change stay readable. */
function legacyProjectKey(cwd: string): string {
  return process.platform === 'win32'
    ? projectKey(cwd)
    : cwd.replace(/^\//, '').replaceAll('/', '-');
}

/** Resolve the Claude Code transcript directory for a given working directory:
 *  ~/.claude/projects keyed by cwd.
 *
 *  We used to emit the legacy key unconditionally on POSIX, which silently
 *  stopped matching once Claude Code moved to dashing every non-alphanumeric.
 *  Nothing errored — every caller reads an absent directory as "no transcripts
 *  yet" — so the miss cost months of dead memory condensation (a long run of
 *  `condense-abort`s with zero successes) and a usage reconciler quietly reading
 *  nothing at all.
 *
 *  Prefer the CURRENT spelling; fall back to the legacy one only when it exists
 *  and the current one does not, so pre-change installs stay readable. That order
 *  is not cosmetic: this harness itself created legacy-named directories by
 *  copying transcripts into them, so a fallback-first resolver would keep reading
 *  our own stale copies forever. When neither exists we return the CURRENT
 *  spelling, because callers that go on to create the directory must create the
 *  one Claude Code will actually read. */
export function projectDir(cwd: string): string {
  const root = path.join(os.homedir(), '.claude/projects');
  const current = path.join(root, projectKey(cwd));
  if (existsSync(current)) return current;
  // For cwd '/' the legacy key is the empty string, and path.join(root, '')
  // collapses to the projects ROOT — which always exists, so the fallback would
  // hand back a directory holding every project rather than one, and callers
  // would read/seed `~/.claude/projects/<session>.jsonl`. An empty key is not a
  // project name; treat it as no legacy candidate at all.
  const legacyKey = legacyProjectKey(cwd);
  if (!legacyKey) return current;
  const legacy = path.join(root, legacyKey);
  return existsSync(legacy) ? legacy : current;
}

/** Ensure session `<sessionId>.jsonl` exists in `cwd`'s Claude project dir so a
 *  `claude --resume <sessionId>` spawn in that cwd can find it. Claude keys
 *  transcripts by cwd, so a session started elsewhere is invisible until its
 *  `.jsonl` is seeded across.
 *
 *  - Already present in the target project dir → no-op, returns true.
 *  - Found under a DIFFERENT project dir (resumed from another cwd — the Add
 *    Agent "resume session" flow, #2) → copied across, returns true.
 *  - Not found anywhere → returns false, so the caller can fall back to a fresh
 *    session instead of launching a broken `--resume`.
 *
 *  Best-effort: any fs error yields false rather than throwing into the spawn. */
/** A Claude session id is a UUID. Renderer-supplied ids flow into `path.join`, so
 *  reject anything outside this charset before using one as a path component (a
 *  crafted id like `../../x` would otherwise traverse out of the project dirs). */
const VALID_SESSION_ID = /^[A-Za-z0-9_-]+$/;

/** Whether `<projectDir(cwd)>/<sessionId>.jsonl` exists: one `existsSync`, no read.
 *  START-FIXES-163 (1): the gate before an OTel sample's session id may become the
 *  resume key. A resumed Claude emits its start-up metric under a fresh process id
 *  that has no transcript anywhere (WHY-162 chain 2). */
export function sessionTranscriptExists(cwd: string, sessionId: string): boolean {
  try {
    if (!cwd || !sessionId || !VALID_SESSION_ID.test(sessionId)) return false;
    return existsSync(path.join(projectDir(cwd), `${sessionId}.jsonl`));
  } catch {
    return false;
  }
}

/** GOD-STARTUP-TOKENS R1: where a session's transcript is (the cwd's project dir first, else any
 *  project dir, as seedSessionTranscript looks), or null. Read only; nothing is copied. */
export function sessionTranscriptPath(cwd: string, sessionId: string): string | null {
  try {
    if (!sessionId || !VALID_SESSION_ID.test(sessionId)) return null;
    const own = path.join(projectDir(cwd), `${sessionId}.jsonl`);
    if (existsSync(own)) return own;
    const projectsRoot = path.join(os.homedir(), '.claude/projects');
    if (!existsSync(projectsRoot)) return null;
    for (const dir of readdirSync(projectsRoot)) {
      const candidate = path.join(projectsRoot, dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

/** May an OTel sample's session id become this agent's resume key? Only when there is
 *  no key yet (the sample is then the only source), or when the sample's own transcript
 *  exists. A phantom start-up id never replaces a real key. */
export function shouldRecordSampleSession(current: string | undefined, sampleId: string, cwd: string | undefined): boolean {
  if (!sampleId) return false;
  if (!current) return true;
  if (current === sampleId) return false;
  return !!cwd && sessionTranscriptExists(cwd, sampleId);
}

/** The Claude resume decision for a restored agent (no user-typed id), as data.
 *  `seed` is seedSessionTranscript bound to the spawn cwd. The last key wins when
 *  its transcript is there. When it is not (a phantom), the id it replaced is tried,
 *  and `miss` says a resume-miss row is owed either way. */
export function chooseResumeSession(
  last: string | undefined,
  previous: string | undefined,
  seed: (sessionId: string) => boolean,
  foreign: (sessionId: string) => boolean = () => false
): { sessionId?: string; miss: boolean; outcome?: 'resumed-previous' | 'fresh'; refused?: string[] } {
  if (!last) return { miss: false };
  // SESSION-CROSSWIRE: an id another agent claims is never resumed (nor seeded); it is
  // listed in `refused` so the resume-miss row says why.
  const refused: string[] = [];
  const usable = (s: string): boolean => {
    if (foreign(s)) { refused.push(s); return false; }
    return seed(s);
  };
  if (usable(last)) return { sessionId: last, miss: false };
  const pick: { sessionId?: string; miss: boolean; outcome?: 'resumed-previous' | 'fresh'; refused?: string[] } =
    previous && previous !== last && usable(previous)
      ? { sessionId: previous, miss: true, outcome: 'resumed-previous' }
      : { miss: true, outcome: 'fresh' };
  if (refused.length) pick.refused = refused;
  return pick;
}

export function seedSessionTranscript(cwd: string, sessionId: string): boolean {
  try {
    if (!sessionId || !VALID_SESSION_ID.test(sessionId)) return false;
    const target = path.join(projectDir(cwd), `${sessionId}.jsonl`);
    if (existsSync(target)) return true;
    const projectsRoot = path.join(os.homedir(), '.claude/projects');
    if (!existsSync(projectsRoot)) return false;
    for (const dir of readdirSync(projectsRoot)) {
      const candidate = path.join(projectsRoot, dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) {
        mkdirSync(path.dirname(target), { recursive: true });
        cpSync(candidate, target);
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Resolve a session id to the ORIGINAL working directory it ran in, for the Add
 *  Agent "resume session" auto-fill. The cwd is read from a transcript RECORD
 *  (every line carries a `cwd` field) — deliberately NOT by un-dashing the
 *  project-dir name, which is lossy when the path itself contains dashes. Searches
 *  every `~/.claude/projects/<dir>/<sessionId>.jsonl`; if more than one matches
 *  (shouldn't — session ids are unique UUIDs) the most-recently-modified wins.
 *  Returns the cwd string, or null if not found / unreadable / no cwd record. */
export function resolveSessionCwd(sessionId: string): string | null {
  try {
    if (!sessionId || !VALID_SESSION_ID.test(sessionId)) return null;
    const projectsRoot = path.join(os.homedir(), '.claude/projects');
    if (!existsSync(projectsRoot)) return null;
    let best: { file: string; mtime: number } | null = null;
    for (const dir of readdirSync(projectsRoot)) {
      const candidate = path.join(projectsRoot, dir, `${sessionId}.jsonl`);
      try {
        const st = statSync(candidate);
        if (!best || st.mtimeMs > best.mtime) best = { file: candidate, mtime: st.mtimeMs };
      } catch { /* not present in this project dir */ }
    }
    if (!best) return null;
    const text = readFileSync(best.file, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed) as { cwd?: unknown };
        if (typeof rec.cwd === 'string' && rec.cwd) return rec.cwd;
      } catch { /* skip a malformed line */ }
    }
    return null;
  } catch {
    return null;
  }
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  estimatedCostUsd: number;
  /** The most-recently-seen model id (normalized, e.g. `claude-opus-4-8`), or
   *  undefined if no priced record was found. Lets the UI label the row. */
  model?: string;
}

function zero(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, estimatedCostUsd: 0 };
}

export interface ReadUsageOptions {
  /** When set, only transcripts whose records carry this `sessionId` are summed.
   *  This is how the co-located-agents double-count (bug #2) is avoided: two
   *  agents sharing a cwd each filter to their own session instead of summing
   *  every `.jsonl` under the shared project dir. When unset, all are summed
   *  (the legacy behavior, used when the agent's session id isn't yet known). */
  sessionId?: string;
  /** REQUIRED: the reading agent's provider. Anything but 'claude' reads nothing
   *  (START-FIXES-163 (2)). Required so no call site can forget it. */
  provider: AgentProvider | undefined;
}

/** Per-file incremental parse state for the usage cache. Transcripts are
 *  append-only JSONL, so a parsed byte range's totals never change — repeat
 *  reads only stat the file and parse the appended tail. Keyed by the file's
 *  PATH alone (SCALE-TRANSCRIPT-SCAN): one parse fills the unfiltered totals AND
 *  each session's totals, so a new session filter reads nothing already parsed
 *  (it used to be dir|file|sessionFilter, so every new session re-read every file). */
interface FileUsageEntry {
  size: number;
  mtimeMs: number;
  /** Bytes parsed so far — always ends on a newline boundary, so a torn
   *  trailing line is simply re-read once the writer completes it. */
  offset: number;
  /** Every assistant record's usage (no session filter). */
  totals: AgentUsage;
  /** The same sums per record `sessionId` (string ids only: the filter is a strict ===). */
  bySession: Map<string, AgentUsage>;
}

const usageCache = new Map<string, FileUsageEntry>();
/** Soft bound; when crossed, the oldest-inserted half is dropped (entries
 *  rebuild on demand). Real fleets have tens of transcripts, not thousands. */
const USAGE_CACHE_MAX = 2048;

/** Add one record's usage to `acc`: model, token sums, and the cost priced by THIS
 *  record's own model (a mixed-model agent, rare, is still costed correctly). */
function addRecordUsage(acc: AgentUsage, model: string | undefined, r: Omit<AgentUsage, 'estimatedCostUsd' | 'model'>, cost: number): void {
  if (model) acc.model = model;
  acc.inputTokens += r.inputTokens;
  acc.outputTokens += r.outputTokens;
  acc.cacheWriteTokens += r.cacheWriteTokens;
  acc.cacheWrite5mTokens += r.cacheWrite5mTokens;
  acc.cacheWrite1hTokens += r.cacheWrite1hTokens;
  acc.cacheReadTokens += r.cacheReadTokens;
  acc.estimatedCostUsd += cost;
}

/** Parse complete JSONL lines into `entry` (the shared per-record logic): every
 *  assistant record with usage goes into the unfiltered totals and, when it carries
 *  a string sessionId, into that session's totals — in file order, so each sum is
 *  the one a filtered parse of the same lines would have made. */
function parseUsageLines(text: string, entry: FileUsageEntry): void {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: {
      type?: unknown;
      sessionId?: unknown;
      message?: { model?: unknown; usage?: Record<string, unknown> };
    };
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (rec.type !== 'assistant') continue;
    const u = rec.message?.usage;
    if (!u) continue;
    const model = typeof rec.message?.model === 'string' ? normalizeModel(rec.message.model) : undefined;
    const cacheCreation = u.cache_creation as Record<string, unknown> | undefined;
    const r = {
      inputTokens: num(u.input_tokens),
      outputTokens: num(u.output_tokens),
      cacheReadTokens: num(u.cache_read_input_tokens),
      cacheWriteTokens: num(u.cache_creation_input_tokens),
      cacheWrite5mTokens: num(cacheCreation?.ephemeral_5m_input_tokens),
      cacheWrite1hTokens: num(cacheCreation?.ephemeral_1h_input_tokens)
    };
    const cost = estimateCostUsd(model, r);
    addRecordUsage(entry.totals, model, r, cost);
    // Session filter (readAgentUsage's sessionId): only records that carry this agent's session.
    if (typeof rec.sessionId === 'string') {
      let acc = entry.bySession.get(rec.sessionId);
      if (!acc) { acc = zero(); entry.bySession.set(rec.sessionId, acc); }
      addRecordUsage(acc, model, r, cost);
    }
  }
}

/** Cached totals for one transcript file, refreshed incrementally: unchanged
 *  size+mtime → cache hit (no read at all); grown → parse only the appended
 *  tail; shrunk (rewritten) → full re-parse. Null when the file vanished. */
function readFileUsage(dir: string, file: string): FileUsageEntry | null {
  const full = path.join(dir, file);
  const key = full;
  let st: { size: number; mtimeMs: number };
  try { st = statSync(full); } catch { usageCache.delete(key); return null; }
  const cached = usageCache.get(key);
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached;
  const fromScratch = !cached || st.size < cached.offset;
  const entry: FileUsageEntry = fromScratch
    ? { size: st.size, mtimeMs: st.mtimeMs, offset: 0, totals: zero(), bySession: new Map() }
    : { size: st.size, mtimeMs: st.mtimeMs, offset: cached!.offset, totals: { ...cached!.totals }, bySession: new Map([...cached!.bySession].map(([k, v]) => [k, { ...v }])) };
  try {
    const fd = openSync(full, 'r');
    try {
      const len = st.size - entry.offset;
      if (len > 0) {
        const buf = Buffer.alloc(len);
        const read = readSync(fd, buf, 0, len, entry.offset);
        const text = buf.subarray(0, read).toString('utf8');
        // Consume only up to the last complete line; a torn trailing line
        // stays unparsed (offset holds at the newline) until the writer
        // finishes it — it is then counted exactly once.
        const lastNl = text.lastIndexOf('\n');
        if (lastNl !== -1) {
          const complete = text.slice(0, lastNl + 1);
          parseUsageLines(complete, entry);
          entry.offset += Buffer.byteLength(complete, 'utf8');
        }
      }
    } finally { closeSync(fd); }
  } catch {
    // Unreadable right now — keep what we have; totals refresh on the next call.
  }
  usageCache.set(key, entry);
  if (usageCache.size > USAGE_CACHE_MAX) {
    let drop = usageCache.size - USAGE_CACHE_MAX / 2;
    for (const k of usageCache.keys()) { if (drop-- <= 0) break; usageCache.delete(k); }
  }
  return entry;
}

/**
 * SCALE-TRANSCRIPT-SCAN (Jim's STARTUP-SCALE-YEAR audit A14): a beat must not stat every
 * transcript a project dir has ever had. Each project dir read here gets ONE non-polling
 * watch (watchDirectorySafely: it closes itself when the dir is gone, the Node 22+ Windows
 * deleted-folder spin). A change event names a file; only those files are stat'ed and
 * tail-read on the next call. A create/delete (rename) re-lists the dir once, so the
 * summing order (readdir's) and so every float sum stays what the stat-all scan made.
 * No watcher, a closed one, or an overflow (an event without a name) means a full scan
 * (readdir + stat every file, as before) for that call; the watch is re-armed after it.
 */
interface DirWatch {
  watcher: FSWatcher | null;
  closed: boolean;
  /** Stat every file on the next call (first sight, an overflow). */
  all: boolean;
  /** Re-list the dir on the next call (a file was created, deleted or renamed). */
  relist: boolean;
  /** Files a change event named since the last call. */
  dirty: Set<string>;
  /** The dir's .jsonl names in readdir order, from the last listing. */
  files: string[];
  lastUsed: number;
  /** When every file was last stat'ed (the N1 safety net below). */
  lastFull: number;
}
const dirWatches = new Map<string, DirWatch>();
/** A dir no call has read for this long (an archived agent, a closed project) loses its watch. */
const DIR_WATCH_IDLE_MS = 10 * 60_000;
/** N1 (Jim, measured on Windows): fs.watch fires no change event for appends through a HELD-OPEN
 *  handle; the events arrive only on close. Claude Code today writes open-append-close (every live
 *  transcript fired events in a 150 s watch), so the watch sees each append. This is a dependency on
 *  the writer's style: if a writer holds a transcript open, its appends are missed until it closes.
 *  The safety net stats every file once per DIR_FULL_RESCAN_MS, so such usage lags by at most that. */
const DIR_FULL_RESCAN_MS = 5 * 60_000;
let watchClock: () => number = () => Date.now();
/** Tests: the clock the watch's idle close and full-rescan safety net read. */
export function __setTranscriptWatchClock(fn: (() => number) | null): void { watchClock = fn ?? (() => Date.now()); }
/** Test seam: events the dir watches took, full scans, and watches armed. */
export const transcriptWatchStats = { events: 0, fullScans: 0, watchers: 0 };
let watchListener: ((dir: string, event: string, filename: string | null) => void) | null = null;
/** Tests: be told when a dir watch takes an event (await it instead of a sleep). */
export function __onTranscriptWatchEvent(fn: ((dir: string, event: string, filename: string | null) => void) | null): void { watchListener = fn; }

function closeDirWatch(dir: string): void {
  const w = dirWatches.get(dir);
  if (!w) return;
  dirWatches.delete(dir);
  w.closed = true;
  try { w.watcher?.close(); } catch { /* already closed */ }
}

/** Close every transcript dir watch (app quit, tests). */
export function closeTranscriptWatches(): void {
  for (const dir of [...dirWatches.keys()]) closeDirWatch(dir);
}

/** Whether `cwd`'s project dir has a live watch (tests). */
export function __transcriptWatchOpen(cwd: string): boolean {
  const w = dirWatches.get(projectDir(cwd));
  return !!w && !w.closed;
}
/** Tests: `cwd`'s dir watch (to emit an overflow or an error on it). */
export function __transcriptWatcher(cwd: string): FSWatcher | null {
  return dirWatches.get(projectDir(cwd))?.watcher ?? null;
}

function armDirWatch(dir: string, now: number): DirWatch {
  const w: DirWatch = { watcher: null, closed: false, all: true, relist: true, dirty: new Set(), files: [], lastUsed: now, lastFull: now };
  try {
    const watcher = watchDirectorySafely(dir, (event, filename) => {
      transcriptWatchStats.events += 1;
      if (filename === null) w.all = true;
      else if (event === 'rename') { w.relist = true; w.dirty.add(filename); }
      else w.dirty.add(filename);
      watchListener?.(dir, event, filename);
    });
    watcher.on('close', () => { w.closed = true; });
    watcher.on('error', () => { w.closed = true; });   // watchDirectorySafely closes it; 'close' comes a tick later
    w.watcher = watcher;
    transcriptWatchStats.watchers += 1;
  } catch {
    w.closed = true;   // no watch: this call scans everything and the next one tries again
  }
  dirWatches.set(dir, w);
  return w;
}

/** The dir's transcript files with fresh usage: a full scan when the watch can't vouch for
 *  them, else only the files an event named (the rest are unchanged cache entries). */
function dirUsageEntries(dir: string): FileUsageEntry[] {
  const now = watchClock();
  for (const [d, other] of dirWatches) if (d !== dir && now - other.lastUsed > DIR_WATCH_IDLE_MS) closeDirWatch(d);
  let w = dirWatches.get(dir);
  if (w && w.closed) { closeDirWatch(dir); w = undefined; }
  // Armed BEFORE the scan below: a write after the scan's stat is an event for the next call.
  if (!w) w = armDirWatch(dir, now);
  w.lastUsed = now;
  const full = w.all || w.closed || now - w.lastFull >= DIR_FULL_RESCAN_MS;
  // N2: list first. A readdir that throws (EPERM/EBUSY, an AV lock) keeps the pending dirty set
  // and flags, so the next call retries them instead of serving stale entries.
  if (full || w.relist) { w.files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')); w.relist = false; }
  const dirty = w.dirty;
  w.dirty = new Set();
  w.all = false;
  if (full) { w.lastFull = now; transcriptWatchStats.fullScans += 1; }
  const out: FileUsageEntry[] = [];
  for (const file of w.files) {
    const cached = full || dirty.has(file) ? undefined : usageCache.get(path.join(dir, file));
    const entry = cached ?? readFileUsage(dir, file);
    if (entry) out.push(entry);
  }
  // A watch that could not start (or closed) vouches for nothing: the next call re-arms.
  if (w.closed) closeDirWatch(dir);
  return out;
}

/** Sum real token usage across Claude Code transcripts for `cwd`, pricing each
 *  assistant record by ITS OWN model (fixes cost bug #1 — no more Sonnet for
 *  everyone) via the fallback price table. Optionally filtered to one session
 *  (fixes bug #2). Resilient by design: any unreadable file or malformed line is
 *  skipped, and any unexpected failure yields a zeroed result rather than
 *  throwing into the IPC handler. This is the OFFLINE reconciler / fallback —
 *  the live source is the OTel collector (`telemetry.ts`).
 *
 *  Called from the ~30s breaker/cost beat for every agent without live OTel, so
 *  it must stay cheap on year-old transcript dirs: with the dir watch above, a
 *  steady-state call is one existsSync of the dir plus a stat (and tail read) of
 *  each file that changed since the last call (SCALE-TRANSCRIPT-SCAN). */
export function readAgentUsage(cwd: string, opts: ReadUsageOptions = { provider: undefined }): AgentUsage {
  const usage = zero();
  if (!mayReadClaudeTranscripts(opts.provider)) return usage;
  transcriptReadStats.usageDirScans += 1;
  try {
    const dir = projectDir(cwd);
    if (!existsSync(dir)) { closeDirWatch(dir); return usage; }
    let lastModel: string | undefined;
    for (const file_ of dirUsageEntries(dir)) {
      // A filter sums only that session's records (none in this file: nothing to add).
      const entry = opts.sessionId ? (file_.bySession.has(opts.sessionId) ? { totals: file_.bySession.get(opts.sessionId)! } : null) : file_;
      if (!entry) continue;
      usage.inputTokens += entry.totals.inputTokens;
      usage.outputTokens += entry.totals.outputTokens;
      usage.cacheWriteTokens += entry.totals.cacheWriteTokens;
      usage.cacheWrite5mTokens += entry.totals.cacheWrite5mTokens;
      usage.cacheWrite1hTokens += entry.totals.cacheWrite1hTokens;
      usage.cacheReadTokens += entry.totals.cacheReadTokens;
      usage.estimatedCostUsd += entry.totals.estimatedCostUsd;
      if (entry.totals.model) lastModel = entry.totals.model;
    }
    if (lastModel) usage.model = lastModel;
    return usage;
  } catch {
    return zero();
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Current context size (tokens) of a live session: the token accounting of the
 *  LAST assistant message in its transcript — input + cache read/write is what
 *  the model just consumed as context, plus its output which joins the context
 *  for the next turn. Tail-reads the file (transcripts grow to many MB), so a
 *  poll stays cheap. Returns null when the transcript is missing/unreadable or
 *  holds no assistant message yet. */
const CONTEXT_TAIL_BYTES = 256 * 1024;

export function readContextTokens(transcriptPath: string, provider: AgentProvider | undefined): number | null {
  if (!mayReadClaudeTranscripts(provider)) return null;
  transcriptReadStats.contextReads += 1;
  try {
    if (!existsSync(transcriptPath)) return null;
    const fd = openSync(transcriptPath, 'r');
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, CONTEXT_TAIL_BYTES);
      if (len === 0) return null;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      // Scan from the end; the very first chunk line may be cut mid-record and
      // simply fails to parse, which is fine.
      for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i].trim();
        if (!trimmed) continue;
        let rec: { type?: unknown; message?: { usage?: Record<string, unknown> } };
        try {
          rec = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (rec.type !== 'assistant') continue;
        const u = rec.message?.usage;
        if (!u) continue;
        return num(u.input_tokens) + num(u.output_tokens)
          + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
      }
      return null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}
