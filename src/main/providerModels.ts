/**
 * REFRESH-MODELS (1.1.73; the Human's call, god c6e41f/df3983): ONE models file, filled ONLY when the
 * user presses Settings -> Agents & Models -> "Refresh models". Every model picker reads it. The
 * hard-coded lists in the renderer are only the floor, used when the file is missing or a provider
 * could not be listed. Nothing is looked up at startup or when a picker opens.
 *
 * Per provider, measured 2026-09-28 (REFRESH-MODELS-PLAN.md):
 * - antigravity: `agy models`, one `slug<TAB>label` line per model (agy 1.2.12, no sign-in).
 *   `--model` takes the LABEL.
 * - codex: `codex debug models`, the raw catalog as JSON (codex 0.157.1). Only
 *   `visibility: "list"` models are offered; the output is ~600 KB.
 * - opencode: `opencode models`, one `provider/model` per line (documented; not installed here).
 * - claude (CLAUDE-MODEL-LIST-STALE, 1.1.80): Claude Code's OWN list, the one /model shows, from its
 *   initialize handshake: `claude -p --input-format stream-json --output-format stream-json --verbose`,
 *   one control_request {subtype: initialize} on stdin, `response.response.models` from the
 *   control_response on stdout; then stdin is ended and the process tree killed, all inside a 10 s
 *   time box (claude 2.1.287: ~1 s, 0 tokens, works on the OAuth login). The app never reads any
 *   credentials; the reply's `account` is reduced to "signed in or not" and nothing of it is kept.
 *   The Anthropic Models API (a stored BYOK key) is used ONLY when Claude Code is not installed.
 * - everyone else: not installed, or no known list command -> the floor.
 *
 * Every lookup is async: executables are resolved with `where` / `command -v` through execFile,
 * never a sync child process on main. A .cmd/.bat shim runs through cmd.exe /d /s /c with fixed
 * arguments; a path with a quote or cmd metacharacter is refused. Each run is hidden and time-boxed.
 * The file is re-validated when it is loaded (once per process, then cached; a refresh replaces the
 * cached copy with its own validated result), so a hand edit cannot put an unsafe id on a command line.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn as nodeSpawn } from 'node:child_process';
import { execP, resolveCliAsync, TREE_KILL_TIMEOUT_MS, type ExecErr, type ResolverDeps, type ResolverExec } from './commandResolver';

import type { ModelEntry, ProviderStatus, ProviderModels, ModelsCatalog, ModelsRefreshRow } from '../shared/modelCatalog';
export type { ModelEntry, ProviderStatus, ProviderModels };
export type ModelsFile = ModelsCatalog;

export const MODELS_FILE_VERSION = 1;
export const LIST_TIMEOUT_MS = 20_000;
const MAX_MODELS = 64;
/** A model id goes on a command line (`--model <id>`): printable, no quotes, no shell or cmd
 *  metacharacters. `[` `]` for Claude's `[1m]`, `/` for opencode's `provider/model`, spaces and
 *  parentheses for agy's labels. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9 ._()/:+[\]-]{0,99}$/;
/** A label is only displayed (React escapes it); still: no control characters, bounded. */
const SAFE_LABEL = /^[^\u0000-\u001f\u007f]{1,80}$/;
const STATUSES: readonly ProviderStatus[] = ['ok', 'not-installed', 'unsupported', 'failed'];

/** Keep only well-formed, unique entries (by id), at most MAX_MODELS. Total. */
export function cleanModels(list: unknown): ModelEntry[] {
  if (!Array.isArray(list)) return [];
  const out: ModelEntry[] = [];
  const seen = new Set<string>();
  for (const m of list) {
    const id = m && typeof (m as ModelEntry).id === 'string' ? (m as ModelEntry).id.trim() : '';
    const label = m && typeof (m as ModelEntry).label === 'string' ? (m as ModelEntry).label.trim() : '';
    if (!SAFE_ID.test(id) || !SAFE_LABEL.test(label) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label });
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

// ── Parsers (each total: null = nothing usable) ──────────────────────────────────────────

/** "Gemini 3.8 Flash (Medium)" -> "Gemini 3.8 Flash · Med"; "(Thinking)" dropped. */
export function agyDisplayLabel(label: string): string {
  const m = /^(.*\S) \((High|Medium|Low|Thinking)\)$/.exec(label);
  if (!m) return label;
  if (m[2] === 'Thinking') return m[1];
  return /^Gemini /.test(m[1]) ? `${m[1]} · ${m[2] === 'Medium' ? 'Med' : m[2]}` : m[1];
}

export function parseAgyModels(stdout: unknown): ModelEntry[] | null {
  if (typeof stdout !== 'string') return null;
  const raw: ModelEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.split('\t');
    if (parts.length !== 2 || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(parts[0].trim())) continue;
    const id = parts[1].trim(); // the LABEL is what --model takes
    raw.push({ id, label: agyDisplayLabel(id) });
  }
  // a shortened label that collides keeps the full label
  for (const m of raw) if (raw.filter((x) => x.label === m.label).length > 1) m.label = m.id;
  const out = cleanModels(raw);
  return out.length ? out : null;
}

export function parseCodexModels(stdout: unknown): ModelEntry[] | null {
  if (typeof stdout !== 'string') return null;
  const line = stdout.split(/\r?\n/).find((l) => l.trimStart().startsWith('{'));
  if (!line) return null;
  let j: { models?: Array<{ slug?: unknown; display_name?: unknown; visibility?: unknown; priority?: unknown }> };
  try { j = JSON.parse(line); } catch { return null; }
  if (!Array.isArray(j.models)) return null;
  const listed = j.models
    .filter((m) => m && m.visibility === 'list' && typeof m.slug === 'string')
    .sort((a, b) => (typeof a.priority === 'number' ? a.priority : 999) - (typeof b.priority === 'number' ? b.priority : 999))
    .map((m) => ({ id: String(m.slug), label: typeof m.display_name === 'string' && m.display_name.trim() ? m.display_name.trim().replace(/^(GPT-[\d.]+)-/, '$1 ') : String(m.slug) }));
  const out = cleanModels(listed);
  return out.length ? out : null;
}

export function parseOpencodeModels(stdout: unknown): ModelEntry[] | null {
  if (typeof stdout !== 'string') return null;
  const raw = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(l))
    .map((id) => ({ id, label: id }));
  const out = cleanModels(raw);
  return out.length ? out : null;
}

export function parseAnthropicModels(body: unknown): ModelEntry[] | null {
  const data = (body as { data?: Array<{ id?: unknown; display_name?: unknown; type?: unknown }> } | null)?.data;
  if (!Array.isArray(data)) return null;
  const out = cleanModels(data.filter((m) => m && typeof m.id === 'string')
    .map((m) => ({ id: String(m.id), label: typeof m.display_name === 'string' && m.display_name.trim() ? m.display_name.trim() : String(m.id) })));
  return out.length ? out : null;
}

/** "claude-opus-5-5" -> "Opus 5.5", "claude-haiku-4-5-20251001" -> "Haiku 4.5"; anything else as is. */
export function claudeLabel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : id;
}

/** The picker entries from the initialize reply's `models` (what /model shows). An alias (default,
 *  opus, sonnet, ...) becomes its resolved full id, so a saved model, the pricing and the curated
 *  `[1m]` variants all keep matching; "default" is the picker's own "CLI default" row, so it only
 *  adds its resolved model. Duplicates keep the first. */
export function claudeModelsFromInit(list: unknown): ModelEntry[] | null {
  if (!Array.isArray(list)) return null;
  const raw: ModelEntry[] = [];
  for (const m of list as Array<{ value?: unknown; resolvedModel?: unknown; displayName?: unknown }>) {
    if (!m || typeof m.value !== 'string') continue;
    const id = typeof m.resolvedModel === 'string' && m.resolvedModel.trim() ? m.resolvedModel.trim() : m.value.trim();
    const shown = typeof m.displayName === 'string' ? m.displayName.trim() : '';
    // a signed-out or default row says "Opus" / "Default (recommended)": the version comes from the id
    const label = m.value !== 'default' && /\d/.test(shown) ? shown : claudeLabel(id);
    raw.push({ id, label });
  }
  const out = cleanModels(raw);
  return out.length ? out : null;
}

/** Signed in or not, from the reply's `account`, and NOTHING else of it leaves this function: an
 *  OAuth login carries its subscription, an API key its key source; a signed-out CLI says
 *  tokenSource "none". null = cannot tell (an older CLI without `account`, or Bedrock / Vertex /
 *  Foundry, whose credentials are the cloud's): never treated as an error. */
function signedInFrom(account: unknown): boolean | null {
  if (!account || typeof account !== 'object') return null;
  const a = account as Record<string, unknown>;
  const has = (k: string): boolean => typeof a[k] === 'string' && a[k] !== '';
  if (has('apiProvider') && a.apiProvider !== 'firstParty') return null;
  if (has('subscriptionType') || has('email') || has('apiKeySource')) return true;
  if (a.tokenSource === 'none') return false;
  return has('tokenSource') ? true : null;
}

export const CLAUDE_REQUEST_ID = 'models-refresh-1';
export interface ClaudeInit { models: ModelEntry[] | null; signedIn: boolean | null; error: string | null }

/** The control_response to our initialize request in claude's stdout (one JSON object per line;
 *  any other line is skipped). Null until it has arrived. Only models and "signed in" are returned. */
export function parseClaudeInitialize(stdout: unknown, requestId = CLAUDE_REQUEST_ID): ClaudeInit | null {
  if (typeof stdout !== 'string') return null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trimStart().startsWith('{')) continue;
    let j: { type?: unknown; response?: { subtype?: unknown; request_id?: unknown; error?: unknown; response?: { models?: unknown; account?: unknown } } };
    try { j = JSON.parse(line); } catch { continue; }
    if (!j || j.type !== 'control_response' || !j.response || j.response.request_id !== requestId) continue;
    if (j.response.subtype !== 'success') return { models: null, signedIn: null, error: String(j.response.error ?? 'error').slice(0, 300) };
    const r = j.response.response;
    return { models: claudeModelsFromInit(r?.models), signedIn: signedInFrom(r?.account), error: null };
  }
  return null;
}

// ── The file ─────────────────────────────────────────────────────────────────────────────

/** Re-validate a models file (shape AND every entry). Null when unusable. */
export function validModelsFile(v: unknown): ModelsFile | null {
  const f = v as { version?: unknown; refreshedAt?: unknown; providers?: unknown } | null;
  if (!f || f.version !== MODELS_FILE_VERSION || typeof f.refreshedAt !== 'number' || !f.providers || typeof f.providers !== 'object') return null;
  const providers: Record<string, ProviderModels> = {};
  for (const [id, p] of Object.entries(f.providers as Record<string, unknown>)) {
    if (!/^[a-z][a-z-]{0,30}$/.test(id) || !p || typeof p !== 'object') continue;
    const q = p as ProviderModels;
    if (!STATUSES.includes(q.status)) continue;
    const entry: ProviderModels = { status: q.status };
    if (typeof q.source === 'string') entry.source = q.source.slice(0, 80);
    if (typeof q.fetchedAt === 'number') entry.fetchedAt = q.fetchedAt;
    if (typeof q.reason === 'string') entry.reason = q.reason.slice(0, 120);
    const models = cleanModels(q.models);
    if (models.length) entry.models = models;
    if (entry.status === 'ok' && !entry.models) continue; // "ok" with nothing usable is not ok
    providers[id] = entry;
  }
  return { version: MODELS_FILE_VERSION, refreshedAt: f.refreshedAt, providers };
}

// ── Running a CLI (async only) ───────────────────────────────────────────────────────────

// SYNC-CHILD-CALLS: the resolver (resolveCliAsync) and its exec primitive (execP, with the
// MODELS-173-AUDIT Windows tree-kill time box) now live in commandResolver.ts, the one module
// main resolves commands through. Re-exported unchanged.
export type ModelsExec = ResolverExec;
export type CliDeps = ResolverDeps;
export { resolveCliAsync, TREE_KILL_TIMEOUT_MS };

function reasonOf(err: ExecErr): string {
  if (err.killed) return 'timeout';
  if (typeof err.code === 'number') return `exit ${err.code}`;
  return String(err.code ?? err.message ?? 'error').slice(0, 80);
}

/** Run `<exe> <args>` (a .cmd/.bat through cmd.exe). The args are fixed literals, never user input. */
export async function runCli(d: CliDeps, exe: string, args: string[], maxBuffer: number, timeout = LIST_TIMEOUT_MS): Promise<{ stdout: string } | { reason: string }> {
  let r;
  if (d.platform === 'win32' && /\.(cmd|bat)$/i.test(exe)) {
    if (/["%^&|<>!\r\n]/.test(exe) || args.some((a) => !/^[a-z-]+$/.test(a))) return { reason: 'unsafe-path' };
    r = await execP(d, d.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${exe}" ${args.join(' ')}"`], timeout, maxBuffer, true);
  } else {
    r = await execP(d, exe, args, timeout, maxBuffer);
  }
  return 'stdout' in r ? { stdout: r.stdout } : { reason: reasonOf(r.err) };
}

// ── Adapters ─────────────────────────────────────────────────────────────────────────────

export type ListResult = { status: 'ok'; models: ModelEntry[]; source: string } | { status: Exclude<ProviderStatus, 'ok'>; reason: string; source?: string };
export type Adapter = () => Promise<ListResult>;

/** A provider whose CLI can list its models. */
export function cliAdapter(d: CliDeps, bin: string, args: string[], parse: (s: unknown) => ModelEntry[] | null, maxBuffer = 256 * 1024): Adapter {
  const source = `${bin} ${args.join(' ')}`;
  return async () => {
    const exe = await resolveCliAsync(d, bin);
    if (!exe) return { status: 'not-installed', reason: `${bin} not found`, source };
    const r = await runCli(d, exe, args, maxBuffer);
    if ('reason' in r) return { status: 'failed', reason: r.reason, source };
    const models = parse(r.stdout);
    return models ? { status: 'ok', models, source } : { status: 'failed', reason: 'unparsable output', source };
  };
}

/** A provider with no list command: only tells whether it is installed. */
export function noListAdapter(d: CliDeps, bin: string): Adapter {
  return async () => ((await resolveCliAsync(d, bin))
    ? { status: 'unsupported', reason: 'no list command (built-in list kept)' }
    : { status: 'not-installed', reason: `${bin} not found` });
}

/** The Anthropic Models API, ONLY with a stored BYOK key (never subscription credentials). Claude's
 *  adapter uses it only when Claude Code itself is not installed. */
export function anthropicAdapter(getKey: () => string | undefined, fetchJson: (url: string, headers: Record<string, string>, timeoutMs: number) => Promise<{ status: number; body: unknown }>): Adapter {
  const source = 'Anthropic Models API (your API key)';
  return async () => {
    const key = getKey();
    if (!key) return { status: 'unsupported', reason: 'no list command (no Anthropic API key stored; built-in list kept)' };
    try {
      const r = await fetchJson('https://api.anthropic.com/v1/models?limit=100', { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, LIST_TIMEOUT_MS);
      if (r.status !== 200) return { status: 'failed', reason: `HTTP ${r.status}`, source };
      const models = parseAnthropicModels(r.body);
      return models ? { status: 'ok', models, source } : { status: 'failed', reason: 'unparsable response', source };
    } catch (e) {
      return { status: 'failed', reason: /abort|timeout/i.test(String((e as Error)?.name ?? e)) ? 'timeout' : 'request failed', source };
    }
  };
}

// ── Claude: the initialize handshake ─────────────────────────────────────────────────────

export const CLAUDE_LIST_TIMEOUT_MS = 10_000;
/** All four are needed: --input-format stream-json needs -p and --output-format stream-json, and
 *  that needs --verbose (claude exits 1 without it). */
export const CLAUDE_LIST_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
const CLAUDE_MAX_STDOUT = 4 * 1024 * 1024;

export const CLAUDE_REASONS = {
  notFound: 'claude not found',
  notSignedIn: 'not signed in: open Claude Code and run /login',
  timeout: `timed out after ${CLAUDE_LIST_TIMEOUT_MS / 1000} s`,
  verbose: 'Claude Code refused --verbose: update Claude Code',
  tooOld: 'this Claude Code cannot list its models: update Claude Code',
  noList: 'no model list in its reply'
} as const;

/** What a stdio child looks like to the runner (node's ChildProcess; a fake in the tests). */
export interface ClaudeChild {
  pid?: number;
  stdin: { write: (s: string) => unknown; end: () => unknown; on: (e: 'error', cb: () => void) => unknown } | null;
  stdout: { on: (e: 'data', cb: (d: Buffer | string) => void) => unknown } | null;
  stderr: { on: (e: 'data', cb: (d: Buffer | string) => void) => unknown } | null;
  on: (e: 'exit' | 'close' | 'error', cb: (x: unknown) => void) => unknown;
  kill: (sig?: NodeJS.Signals) => unknown;
}
export type ClaudeSpawn = (file: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; windowsHide: true; windowsVerbatimArguments?: boolean; detached?: boolean; stdio: ['pipe', 'pipe', 'pipe'] }) => ClaudeChild;
/** `kill` is process.kill (a seam for the POSIX group kill in tests). */
export type ClaudeDeps = CliDeps & { spawn?: ClaudeSpawn; tmpDir?: string; kill?: (pid: number, sig: NodeJS.Signals) => unknown };

/** A failure in plain words, from claude's stderr (or a control_response error) and its exit. */
export function claudeFailure(text: string, code?: unknown): string {
  if (/requires --verbose/i.test(text)) return CLAUDE_REASONS.verbose;
  if (/not (logged|signed) in|please (log|sign) ?in|\/login|unauthori[sz]ed|authenticat|invalid (api|x-api)[- ]key|\b401\b/i.test(text)) return CLAUDE_REASONS.notSignedIn;
  if (/unknown option|unrecognized option|unknown subtype|not supported/i.test(text)) return CLAUDE_REASONS.tooOld;
  return typeof code === 'number' ? `exit ${code}` : 'claude failed';
}

/**
 * Run the handshake: write ONE initialize request, read lines until its control_response, then end
 * stdin and kill the process TREE (win32: taskkill /T /F, as execP does; the .cmd shim's cmd.exe has
 * claude.exe below it). The whole run is time-boxed; a timeout also kills the tree. cwd is the temp
 * dir, so the run never lands in an agent's project. Never rejects.
 */
export function runClaudeInit(d: ClaudeDeps, exe: string, timeout = CLAUDE_LIST_TIMEOUT_MS): Promise<{ init: ClaudeInit } | { reason: string; notFound?: true }> {
  return new Promise((resolve) => {
    let file = exe; let args = CLAUDE_LIST_ARGS;
    let verbatim = false;
    if (d.platform === 'win32' && /\.(cmd|bat)$/i.test(exe)) {
      if (/["%^&|<>!\r\n]/.test(exe)) { resolve({ reason: 'unsafe-path' }); return; }
      file = d.env.ComSpec || 'cmd.exe'; args = ['/d', '/s', '/c', `""${exe}" ${CLAUDE_LIST_ARGS.join(' ')}"`]; verbatim = true;
    }
    let child: ClaudeChild;
    let out = ''; let err = ''; let settled = false; let exited = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const killTree = (): void => {
      if (exited) return;
      try { child.stdin?.end(); } catch { /* gone */ }
      const pid = typeof child.pid === 'number' ? child.pid : null;
      if (d.platform === 'win32' && pid) {
        try { d.exec('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: TREE_KILL_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 }, () => {}); } catch { /* best effort */ }
      } else if (pid) {
        // POSIX: claude runs as the leader of its own process group (detached), so the group goes
        try { (d.kill ?? process.kill)(-pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      }
    };
    const done = (r: { init: ClaudeInit } | { reason: string; notFound?: true }): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      killTree();
      resolve(r);
    };
    try {
      child = (d.spawn ?? (nodeSpawn as unknown as ClaudeSpawn))(file, args, { cwd: d.tmpDir ?? tmpdir(), env: d.env, windowsHide: true, ...(verbatim ? { windowsVerbatimArguments: true } : {}), ...(d.platform === 'win32' ? {} : { detached: true }), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve((e as { code?: unknown })?.code === 'ENOENT' ? { reason: CLAUDE_REASONS.notFound, notFound: true } : { reason: 'could not start claude' });
      return;
    }
    timer = setTimeout(() => done({ reason: CLAUDE_REASONS.timeout }), timeout);
    child.on('error', (e) => done((e as { code?: unknown })?.code === 'ENOENT' ? { reason: CLAUDE_REASONS.notFound, notFound: true } : { reason: 'could not start claude' }));
    child.stdout?.on('data', (b) => {
      if (settled || out.length > CLAUDE_MAX_STDOUT) return;
      out += String(b);
      if (!out.includes('control_response')) return;
      const init = parseClaudeInitialize(out.slice(0, out.lastIndexOf('\n') + 1));
      if (init) done({ init });
    });
    child.stderr?.on('data', (b) => { if (err.length < 16 * 1024) err += String(b); });
    // the final parse waits for 'close' (all output read): 'exit' can come before stderr's last chunk
    let exitCode: unknown = null;
    child.on('exit', (code) => { exitCode = code; });
    child.on('close', (code) => {
      exited = true;
      const c = code ?? exitCode;
      const init = parseClaudeInitialize(out);
      done(init ? { init } : { reason: c === 0 && !err.trim() ? CLAUDE_REASONS.noList : claudeFailure(err, c) });
    });
    try {
      child.stdin?.on('error', () => { /* claude exited before reading: its exit says why */ });
      child.stdin?.write(`${JSON.stringify({ type: 'control_request', request_id: CLAUDE_REQUEST_ID, request: { subtype: 'initialize' } })}\n`);
    } catch { /* the exit or the time box reports it */ }
  });
}

/** Claude Code on Bedrock, Vertex or Foundry (CLAUDE_CODE_USE_*): no Anthropic login to look for. */
export function thirdPartyProvider(env: NodeJS.ProcessEnv): boolean {
  return ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].some((k) => /^(1|true|yes|on)$/i.test(String(env[k] ?? '').trim()));
}

/**
 * Claude: Claude Code's own list. The CLI is the source of truth; the Anthropic Models API (a stored
 * BYOK key) is used ONLY when Claude Code is not installed, and the row says so.
 */
export function claudeAdapter(d: ClaudeDeps, getKey: () => string | undefined, fetchJson: Parameters<typeof anthropicAdapter>[1]): Adapter {
  const source = 'claude initialize (the /model list)';
  return async () => {
    const exe = await resolveCliAsync(d, 'claude');
    if (!exe) {
      if (!getKey()) return { status: 'not-installed', reason: CLAUDE_REASONS.notFound };
      const api = await anthropicAdapter(getKey, fetchJson)();
      return api.status === 'ok'
        ? { ...api, source: 'Anthropic Models API (your API key; Claude Code not found)' }
        : { ...api, reason: `Claude Code not found; the API key listing failed: ${api.reason}` };
    }
    const r = await runClaudeInit(d, exe);
    if ('reason' in r) return { status: r.notFound ? 'not-installed' : 'failed', reason: r.reason, source };
    if (r.init.error !== null) return { status: 'failed', reason: claudeFailure(r.init.error), source };
    if (r.init.signedIn === false && !thirdPartyProvider(d.env)) return { status: 'failed', reason: CLAUDE_REASONS.notSignedIn, source };
    return r.init.models ? { status: 'ok', models: r.init.models, source } : { status: 'failed', reason: CLAUDE_REASONS.noList, source };
  };
}

// ── The store ────────────────────────────────────────────────────────────────────────────

export type RefreshRow = ModelsRefreshRow;

export class ProviderModelStore {
  private file: ModelsFile | null = null;
  private loaded = false;
  private running: Promise<{ file: ModelsFile; rows: RefreshRow[] }> | null = null;

  constructor(private readonly deps: { path: string; now: () => number; log?: (row: Record<string, unknown>) => void }) {}

  /** The validated file, or null. A FILE READ only (once per process); never a lookup. */
  read(): ModelsFile | null {
    if (!this.loaded) {
      this.loaded = true;
      try { if (existsSync(this.deps.path)) this.file = validModelsFile(JSON.parse(readFileSync(this.deps.path, 'utf8'))); } catch { this.file = null; }
    }
    return this.file;
  }

  isRefreshing(): boolean { return this.running !== null; }

  /** The button: run every adapter in parallel, merge, write atomically, log one row. One at a time. */
  refresh(adapters: Record<string, Adapter>): Promise<{ file: ModelsFile; rows: RefreshRow[] }> {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        const prev = this.read();
        const ids = Object.keys(adapters);
        const results = await Promise.all(ids.map(async (id) => {
          const t0 = this.deps.now();
          let r: ListResult;
          try { r = await adapters[id](); } catch { r = { status: 'failed', reason: 'error' }; }
          return { id, r, ms: this.deps.now() - t0 };
        }));
        const providers: Record<string, ProviderModels> = {};
        const rows: RefreshRow[] = [];
        for (const { id, r, ms } of results) {
          const before = prev?.providers[id];
          const beforeIds = new Set((before?.status === 'ok' || before?.status === 'failed' ? before.models ?? [] : []).map((m) => m.id));
          if (r.status === 'ok') {
            providers[id] = { status: 'ok', source: r.source, fetchedAt: this.deps.now(), models: r.models };
            const now = new Set(r.models.map((m) => m.id));
            rows.push({ provider: id, status: 'ok', count: r.models.length, added: r.models.map((m) => m.id).filter((x) => !beforeIds.has(x)), removed: [...beforeIds].filter((x) => !now.has(x)), ms });
          } else if (r.status === 'failed' && before?.models?.length) {
            // A failed run keeps the last good list (the pickers keep using it).
            providers[id] = { status: 'failed', source: r.source ?? before.source, fetchedAt: before.fetchedAt, models: before.models, reason: r.reason };
            rows.push({ provider: id, status: 'failed', count: before.models.length, added: [], removed: [], reason: r.reason, keptLast: true, ms });
          } else {
            providers[id] = { status: r.status, reason: r.reason, ...(r.source ? { source: r.source } : {}) };
            rows.push({ provider: id, status: r.status, count: 0, added: [], removed: [], reason: r.reason, ms });
          }
        }
        const file: ModelsFile = { version: MODELS_FILE_VERSION, refreshedAt: this.deps.now(), providers };
        try {
          mkdirSync(dirname(this.deps.path), { recursive: true });
          const tmp = `${this.deps.path}.tmp`;
          writeFileSync(tmp, JSON.stringify(file, null, 1));
          renameSync(tmp, this.deps.path);
        } catch { /* the in-memory copy still serves this run */ }
        this.file = file;
        this.loaded = true;
        try {
          this.deps.log?.({ kind: 'models-refresh', providers: Object.fromEntries(rows.map((x) => [x.provider, { status: x.status, count: x.count, added: x.added.length, removed: x.removed.length, ...(x.reason ? { reason: x.reason } : {}) }])) });
        } catch { /* diagnostics */ }
        return { file, rows };
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }
}

/** Which providers the button queries, and how (the app's wiring). */
export function defaultAdapters(d: ClaudeDeps, getAnthropicKey: () => string | undefined, fetchJson: Parameters<typeof anthropicAdapter>[1]): Record<string, Adapter> {
  return {
    claude: claudeAdapter(d, getAnthropicKey, fetchJson),
    codex: cliAdapter(d, 'codex', ['debug', 'models'], parseCodexModels, 4 * 1024 * 1024),
    antigravity: cliAdapter(d, 'agy', ['models'], parseAgyModels),
    opencode: cliAdapter(d, 'opencode', ['models'], parseOpencodeModels, 1024 * 1024),
    gemini: noListAdapter(d, 'gemini'),
    grok: noListAdapter(d, 'grok'),
    kimi: noListAdapter(d, 'kimi'),
    qwen: noListAdapter(d, 'qwen'),
    crush: noListAdapter(d, 'crush'),
    pi: noListAdapter(d, 'pi'),
    copilot: noListAdapter(d, 'copilot'),
    cursor: noListAdapter(d, 'cursor-agent')
  };
}
