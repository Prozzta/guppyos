/**
 * HISTORY-VIEW-169: the main-side service behind the `hive:history` IPC.
 *
 * Resolves an agent's CURRENT transcript from its id alone (the renderer never names a
 * path), reads one bounded page of it (historyTail) and normalises the lines
 * (historyNormalize). Electron-free: the four facts it needs are injected, so it runs
 * under node:test against a sandboxed home.
 *
 * Sources:
 *  - Claude Code: the hook-learned transcript_path (only inside Claude's projects dir), else
 *    `projectDir(cwd)/<registry sessionId>.jsonl`.
 *  - Codex: the rollout for the registry sessionId under the agent's own CODEX_HOME, else a
 *    hook transcript_path inside that home, else the home's newest rollout.
 *  - Antigravity: the hook transcript_path (only inside the brain dir), else
 *    `<gemini home>/antigravity-cli/brain/<conversation>/.system_generated/logs/transcript.jsonl`.
 *
 * The resolved path is cached per agent and re-resolved only when the session id or the
 * hook path changes, or the file disappears: the Codex lookup walks dated directories,
 * and that must not happen on every follow poll.
 */
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HISTORY_PAGE_DEFAULT,
  HISTORY_PAGE_MAX,
  type HistoryItem,
  type HistoryPage,
  type HistoryProvider
} from '../shared/history';
import { normalizeLine } from './historyNormalize';
import { readLinesBackward, readLinesForward, type LineRef, type TailLimits } from './historyTail';
import { projectDir } from './transcript';
import { findCodexRollout } from './codexThreadRotation';
import { findNewestRollout } from './codexRolloutCapacity';

export interface HistoryAgentFacts {
  provider?: string;
  cwd?: string;
  sessionId?: string;
}

export interface HistoryDeps {
  agent(agentId: string): HistoryAgentFacts | null;
  transcriptPath(agentId: string): string | undefined;
  codexHomeFor(agentId: string): string | null;
  geminiHome(): string;
}

const AGENT_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

/** Is `child` inside `dir` (after resolution)? */
function inside(dir: string, child: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * HISTORY-169-AUDIT F2: where a hook-reported transcript_path may live, per provider. The
 * hook payload is a CLI's claim, so it is only trusted inside that provider's own store:
 *  - Claude: `<config dir>/projects` (~/.claude, or CLAUDE_CONFIG_DIR when set);
 *  - Codex: the agent's own CODEX_HOME;
 *  - Antigravity: `<gemini home>/antigravity-cli/brain`.
 */
export function claudeProjectRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [path.join(os.homedir(), '.claude', 'projects')];
  const cfg = env.CLAUDE_CONFIG_DIR?.trim();
  if (cfg) roots.push(path.join(cfg, 'projects'));
  return roots;
}

function asProvider(p: string | undefined): HistoryProvider | null {
  const v = p ?? 'claude';
  return v === 'claude' || v === 'codex' || v === 'antigravity' ? v : null;
}

function offsetArg(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

export class HistoryService {
  private cache = new Map<string, { key: string; file: string }>();

  constructor(private readonly deps: HistoryDeps, private readonly limits: TailLimits = {}) {}

  /** The transcript file for an agent, or why there is none. */
  resolve(agentId: string): { provider: HistoryProvider; file: string } | { reason: 'no-agent' | 'unsupported-provider' | 'no-transcript' } {
    const a = this.deps.agent(agentId);
    if (!a) return { reason: 'no-agent' };
    const provider = asProvider(a.provider);
    if (!provider) return { reason: 'unsupported-provider' };
    const sid = a.sessionId && SESSION_ID.test(a.sessionId) ? a.sessionId : '';
    const hookPath = this.deps.transcriptPath(agentId) ?? '';
    const key = `${provider}|${sid}|${hookPath}|${a.cwd ?? ''}`;
    const hit = this.cache.get(agentId);
    if (hit && hit.key === key && existsSync(hit.file)) return { provider, file: hit.file };
    const file = this.locate(agentId, provider, sid, hookPath, a.cwd ?? '');
    if (!file) { this.cache.delete(agentId); return { reason: 'no-transcript' }; }
    this.cache.set(agentId, { key, file });
    return { provider, file };
  }

  private locate(agentId: string, provider: HistoryProvider, sid: string, hookPath: string, cwd: string): string | null {
    const hookOk = hookPath.endsWith('.jsonl') && isFile(hookPath);
    if (provider === 'claude') {
      if (hookOk && claudeProjectRoots().some((root) => inside(root, hookPath))) return hookPath;
      if (sid && cwd && path.isAbsolute(cwd)) {
        const p = path.join(projectDir(cwd), `${sid}.jsonl`);
        if (isFile(p)) return p;
      }
      return null;
    }
    if (provider === 'codex') {
      const home = this.deps.codexHomeFor(agentId);
      if (!home) return null;
      const byId = sid ? findCodexRollout(home, sid) : null;
      if (byId && isFile(byId.path)) return byId.path;
      if (hookOk && inside(home, hookPath)) return hookPath;
      return findNewestRollout(home);
    }
    // antigravity
    const brain = path.join(this.deps.geminiHome(), 'antigravity-cli', 'brain');
    if (hookOk && path.basename(hookPath) === 'transcript.jsonl' && inside(brain, hookPath)) return hookPath;
    if (sid) {
      const p = path.join(brain, sid, '.system_generated', 'logs', 'transcript.jsonl');
      if (isFile(p)) return p;
    }
    return null;
  }

  forget(agentId: string): void {
    this.cache.delete(agentId);
  }

  /** One page. Never throws: a bad request or an unreadable file is a reason, not an error. */
  page(req: unknown): HistoryPage {
    const r = (typeof req === 'object' && req !== null ? req : {}) as Record<string, unknown>;
    const agentId = typeof r.agentId === 'string' && AGENT_ID.test(r.agentId) ? r.agentId : '';
    if (!agentId) return { ok: false, reason: 'no-agent' };
    const resolved = this.resolve(agentId);
    if ('reason' in resolved) return { ok: false, reason: resolved.reason };
    const { provider, file } = resolved;
    const limitRaw = typeof r.limit === 'number' && Number.isFinite(r.limit) ? Math.floor(r.limit) : HISTORY_PAGE_DEFAULT;
    const limit = Math.max(1, Math.min(HISTORY_PAGE_MAX, limitRaw));
    const after = offsetArg(r.after);
    const before = offsetArg(r.before);
    const head = {
      ok: true as const,
      provider,
      fileId: createHash('sha1').update(path.resolve(file)).digest('hex').slice(0, 12),
      fileName: path.basename(file)
    };
    try {
      const toItems = (lines: LineRef[]): HistoryItem[] => lines.flatMap((l) => normalizeLine(provider, l.text, l.offset));
      if (after !== undefined) {
        const size = statSync(file).size;
        // Smaller than where we were: truncated or replaced. The view reloads the tail.
        if (size < after) return { ...head, items: [], start: 0, end: 0, atStart: false, size, reset: true };
        const res = readLinesForward(file, after, this.limits);
        return { ...head, items: toItems(res.lines), start: res.start, end: res.end, atStart: res.start === 0, size: res.size };
      }
      // Each line is normalised once, as it is met (newest first), so the scan can stop
      // as soon as the page is full.
      const groups: HistoryItem[][] = [];
      let seen = 0;
      let count = 0;
      const res = readLinesBackward(file, before ?? null, (newestFirst) => {
        while (seen < newestFirst.length) {
          const l = newestFirst[seen++];
          const items = normalizeLine(provider, l.text, l.offset);
          groups.push(items);
          count += items.length;
        }
        return count >= limit;
      }, this.limits);
      const items = groups.reverse().flat();
      return { ...head, items, start: res.start, end: res.end, atStart: res.start === 0, size: res.size };
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
  }
}
