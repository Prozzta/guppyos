/**
 * RULE-FIX-HOOK-NO-MODEL (god 82f71a): hive hook wiring may use only the zero-token hook types
 * (command, http, mcp_tool), never `prompt` or `agent`, which invoke a model on every event they
 * fire for (~1,100 hooks an hour on this floor: silent usage burn). Until this module nothing
 * checked a hook's type: the writers emit literals, and Codex's config.toml is SEEDED verbatim from
 * the user's ~/.codex/config.toml, so a prompt/agent hook there became part of the file WE write.
 *
 *  - What Guppy writes goes through the allow-list: a disallowed or untyped handler is stripped
 *    (stripHookMap, stripCodexModelHooks) and the strip is logged ('hook-type-guard').
 *  - Files Guppy does not own but the CLI merges in (the user's and the project's settings,
 *    installed plugins, the other entries of a shared hooks file) are scanned only: a finding is a
 *    warning (log row + floor decision), never an edit (foreignHookFiles, scanForeignHookFile).
 * Pure apart from the reads in scanForeignHookFile/foreignHookFiles (an injectable fs).
 */
import * as P from 'node:path';
import { parseToml } from './codexProjectLayers';

/** The hook types that never call a model. */
export const ALLOWED_HOOK_TYPES: ReadonlySet<string> = new Set(['command', 'http', 'mcp_tool']);

/** A handler outside the allow-list: its event and its type ('(none)' = no type given). */
export interface HookFinding { event: string; type: string }

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function handlerType(h: unknown): string {
  if (!isObj(h)) return '(invalid)';
  return typeof h.type === 'string' && h.type ? h.type : '(none)';
}

/** A group is `{ matcher?, hooks: [handler] }`, or (AGY's flat events) a handler itself. */
function groupHandlers(g: unknown): unknown[] {
  return isObj(g) && Array.isArray(g.hooks) ? g.hooks : [g];
}

/** Every handler outside the allow-list in an event map (`{ Event: [group] }`). */
export function scanHookMap(hooks: unknown): HookFinding[] {
  if (!isObj(hooks)) return [];
  const out: HookFinding[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    for (const g of Array.isArray(groups) ? groups : [groups]) {
      for (const h of groupHandlers(g)) {
        const type = handlerType(h);
        if (!ALLOWED_HOOK_TYPES.has(type)) out.push({ event, type });
      }
    }
  }
  return out;
}

/** The event map with every handler outside the allow-list removed (a group left empty goes too). */
export function stripHookMap<T>(hooks: T): { hooks: T; stripped: HookFinding[] } {
  if (!isObj(hooks)) return { hooks, stripped: [] };
  const stripped: HookFinding[] = [];
  const out: Obj = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const kept: unknown[] = [];
    for (const g of Array.isArray(groups) ? groups : [groups]) {
      if (isObj(g) && Array.isArray(g.hooks)) {
        const handlers = g.hooks.filter((h) => {
          const type = handlerType(h);
          if (ALLOWED_HOOK_TYPES.has(type)) return true;
          stripped.push({ event, type });
          return false;
        });
        if (handlers.length) kept.push({ ...g, hooks: handlers });
      } else {
        const type = handlerType(g);
        if (ALLOWED_HOOK_TYPES.has(type)) kept.push(g);
        else stripped.push({ event, type });
      }
    }
    if (kept.length) out[event] = kept;
  }
  return { hooks: out as T, stripped };
}

/** A settings object (Claude --settings, Gemini system settings, Grok's hooks file) with its
 *  `hooks` stripped. Everything else is kept as it is. */
export function stripSettingsHooks<T extends object>(settings: T): { settings: T; stripped: HookFinding[] } {
  const hooks = (settings as Obj).hooks;
  if (hooks === undefined) return { settings, stripped: [] };
  const r = stripHookMap(hooks);
  return { settings: { ...settings, hooks: r.hooks } as T, stripped: r.stripped };
}

/** The hook findings of a Codex config.toml, or null when it does not parse. */
export function scanCodexToml(text: string): HookFinding[] | null {
  let cfg: Obj;
  try { cfg = parseToml(text) as Obj; } catch { return null; }
  return scanHookMap(cfg.hooks);
}

const HEADER = /^[ \t]*\[(\[)?[ \t]*([A-Za-z0-9_.\-"' ]+?)[ \t]*\]\]?[ \t]*(?:#.*)?$/;
const TYPE_LINE = /^[ \t]*type[ \t]*=[ \t]*(?:"([^"]*)"|'([^']*)')/m;

/**
 * Our copy of the Codex seed without its model hooks. Each `[[hooks.<Event>.hooks]]` table whose
 * `type` is outside the allow-list is removed, and a group table (`[[hooks.<Event>]]`) left with
 * none of its handler tables goes too; a group that holds a disallowed handler inline is removed.
 * If the result still scans dirty
 * (or the seed does not parse the same way) every `hooks` table of the seed is removed; `clean`
 * false means even that failed and the spawn must be refused.
 */
export function stripCodexModelHooks(text: string): { text: string; stripped: HookFinding[]; clean: boolean; allHooksDropped: boolean; unparsed?: true } {
  const before = scanCodexToml(text);
  if (before !== null && before.length === 0) return { text, stripped: [], clean: true, allHooksDropped: false };
  // A seed this reader cannot parse is one Codex rejects as well (codexProjectLayers.parseToml
  // throws only on what codex would): the agent cannot start on it, so nothing here can burn.
  if (before === null) return { text, stripped: [], clean: true, allHooksDropped: false, unparsed: true };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  type Block = { name: string | null; lines: string[] };
  const blocks: Block[] = [{ name: null, lines: [] }];
  for (const l of lines) {
    const m = HEADER.exec(l);
    if (m) blocks.push({ name: m[2].replace(/["' ]/g, ''), lines: [l] });
    else blocks[blocks.length - 1].lines.push(l);
  }
  const typeOf = (b: Block): string | null => { const m = TYPE_LINE.exec(b.lines.slice(1).join('\n')); return m ? (m[1] ?? m[2]) : null; };
  const surgical = (): { kept: Block[]; stripped: HookFinding[] } => {
    const kept: Block[] = [];
    const stripped: HookFinding[] = [];
    // The open group table: a group whose every handler table was dropped goes too (a group left
    // with no handlers would be an untyped entry).
    let open: { event: string; block: Block; inline: boolean; kept: number; dropped: number } | null = null;
    const close = (): void => {
      if (open && open.dropped > 0 && open.kept === 0 && !open.inline) kept.splice(kept.indexOf(open.block), 1);
      open = null;
    };
    for (const b of blocks) {
      const handler = b.name ? /^hooks\.([^.]+)\.hooks$/.exec(b.name) : null;
      const group = b.name ? /^hooks\.([^.]+)$/.exec(b.name) : null;
      if (!(handler && open && open.event === handler[1])) close();
      if (handler) {
        const t = typeOf(b) ?? '(none)';
        if (!ALLOWED_HOOK_TYPES.has(t)) { stripped.push({ event: handler[1], type: t }); if (open) open.dropped++; continue; }
        if (open) open.kept++;
      } else if (group) {
        const body = b.lines.slice(1).join('\n');
        const inline = [...body.matchAll(/type[ \t]*=[ \t]*(?:"([^"]*)"|'([^']*)')/g)].map((m) => m[1] ?? m[2]);
        const bad = inline.filter((t) => !ALLOWED_HOOK_TYPES.has(t));
        // (Valid TOML cannot add handler tables to a group whose `hooks` is inline.)
        if (bad.length) { for (const t of bad) stripped.push({ event: group[1], type: t }); continue; }
        open = { event: group[1], block: b, inline: /^[ \t]*hooks[ \t]*=/m.test(body), kept: 0, dropped: 0 };
      }
      kept.push(b);
    }
    close();
    return { kept, stripped };
  };
  const join = (bs: Block[]): string => bs.flatMap((b) => b.lines).join('\n').replace(/\n/g, eol);
  const first = surgical();
  const firstText = join(first.kept);
  const firstScan = scanCodexToml(firstText);
  if (firstScan !== null && firstScan.length === 0) return { text: firstText, stripped: first.stripped, clean: true, allHooksDropped: false };
  // Fallback: no hook of the seed survives.
  const noHooks = blocks.filter((b) => !(b.name === 'hooks' || (b.name ?? '').startsWith('hooks.')));
  const fallbackText = join(noHooks);
  const fallbackScan = scanCodexToml(fallbackText);
  const stripped = before ?? first.stripped;
  return { text: fallbackText, stripped, clean: fallbackScan !== null && fallbackScan.length === 0, allHooksDropped: true };
}

// ── files the CLIs merge in that Guppy does not own: scanned, never edited ──

export type HookFileKind = 'settings' | 'agy-hooks' | 'codex-toml';
export type HookProvider = 'claude' | 'codex' | 'antigravity' | 'gemini' | 'grok';

export interface ForeignHookFile { path: string; kind: HookFileKind; label: string }

export interface HookFs {
  readFile(p: string): string | null;
  /** Entries of a directory (names), or [] when it cannot be listed. */
  list(p: string): Array<{ name: string; dir: boolean }>;
}

/** Plugin hook files are found by a bounded walk (installed plugins can be many). */
export const PLUGIN_WALK_MAX_DEPTH = 6;
export const PLUGIN_WALK_MAX_FILES = 200;

function pluginHookFiles(fs: HookFs, root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > PLUGIN_WALK_MAX_DEPTH || out.length >= PLUGIN_WALK_MAX_FILES) return;
    for (const e of fs.list(dir)) {
      if (out.length >= PLUGIN_WALK_MAX_FILES) return;
      const p = P.join(dir, e.name);
      if (e.dir) { if (e.name !== 'node_modules' && !e.name.startsWith('.')) walk(p, depth + 1); }
      else if (e.name === 'hooks.json' && P.basename(dir) === 'hooks') out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

/** The files a provider's CLI merges into the hooks Guppy gives it, that Guppy does not own. */
export function foreignHookFiles(provider: HookProvider, o: { home: string; cwd: string | null; platform?: NodeJS.Platform; fs: HookFs }): ForeignHookFile[] {
  const { home, cwd } = o;
  const out: ForeignHookFile[] = [];
  if (provider === 'claude') {
    out.push({ path: P.join(home, '.claude', 'settings.json'), kind: 'settings', label: 'your Claude user settings' });
    if (cwd) {
      out.push({ path: P.join(cwd, '.claude', 'settings.json'), kind: 'settings', label: "the project's Claude settings" });
      out.push({ path: P.join(cwd, '.claude', 'settings.local.json'), kind: 'settings', label: "the project's local Claude settings" });
    }
    const managed = (o.platform ?? process.platform) === 'win32' ? 'C:\\Program Files\\ClaudeCode\\managed-settings.json'
      : (o.platform ?? process.platform) === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json' : '/etc/claude-code/managed-settings.json';
    out.push({ path: managed, kind: 'settings', label: 'the managed Claude settings' });
    for (const p of pluginHookFiles(o.fs, P.join(home, '.claude', 'plugins'))) out.push({ path: p, kind: 'settings', label: 'an installed Claude plugin' });
  } else if (provider === 'codex') {
    // The project layers (and a worktree's main checkout) are scanned by codexProjectLayers; the
    // user's own file is our seed (stripped in our copy) and is reported here.
    out.push({ path: P.join(home, '.codex', 'config.toml'), kind: 'codex-toml', label: 'your Codex config (the seed of every Codex agent)' });
  } else if (provider === 'antigravity') {
    out.push({ path: P.join(home, '.gemini', 'config', 'hooks.json'), kind: 'agy-hooks', label: 'the shared Antigravity hooks file' });
    out.push({ path: P.join(home, '.gemini', 'antigravity-cli', 'hooks.json'), kind: 'agy-hooks', label: 'the shared Antigravity CLI hooks file' });
  } else if (provider === 'gemini') {
    out.push({ path: P.join(home, '.gemini', 'settings.json'), kind: 'settings', label: 'your Gemini user settings' });
    if (cwd) out.push({ path: P.join(cwd, '.gemini', 'settings.json'), kind: 'settings', label: "the project's Gemini settings" });
  } else if (provider === 'grok') {
    for (const e of o.fs.list(P.join(home, '.grok', 'hooks'))) {
      if (!e.dir && e.name.endsWith('.json') && e.name !== GROK_OWN_FILE) out.push({ path: P.join(home, '.grok', 'hooks', e.name), kind: 'settings', label: 'a Grok hooks file' });
    }
  }
  return out;
}

/** The one Grok hooks file Guppy writes (installGrokHooks); the others are the user's. */
export const GROK_OWN_FILE = 'munder-hive.json';
/** The one key of a shared Antigravity hooks file that Guppy writes (installAgyHooks). */
export const AGY_OWN_KEY = 'munder-hive';

/** A foreign file's model-hook findings ([] = none, unreadable or unparsable: never a warning on
 *  a guess). Only a NAMED type outside the allow-list is a finding here: an untyped entry is one
 *  the CLI itself rejects, and it is not ours to judge. */
export function scanForeignHookFile(f: ForeignHookFile, fs: HookFs): HookFinding[] {
  return namedOnly(scanForeignRaw(f, fs));
}

/** Only the findings that name a type (the warning set for files Guppy does not own). */
export function namedOnly(fs: HookFinding[]): HookFinding[] {
  return fs.filter((x) => x.type !== '(none)' && x.type !== '(invalid)');
}

function scanForeignRaw(f: ForeignHookFile, fs: HookFs): HookFinding[] {
  const text = fs.readFile(f.path);
  if (text === null) return [];
  if (f.kind === 'codex-toml') return scanCodexToml(text) ?? [];
  let parsed: unknown;
  try { parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch { return []; }
  if (!isObj(parsed)) return [];
  if (f.kind === 'agy-hooks') {
    return Object.entries(parsed).filter(([k]) => k !== AGY_OWN_KEY).flatMap(([k, v]) => scanHookMap(v).map((x) => ({ event: `${k}/${x.event}`, type: x.type })));
  }
  return scanHookMap(parsed.hooks);
}

/** One line for a finding set: `Stop: prompt, PreToolUse: agent`. */
export function findingsText(fs: HookFinding[]): string {
  return fs.map((f) => `${f.event}: ${f.type}`).join(', ');
}
