/**
 * TRUST-SEED-175 (god option A; the real run #2 finding): codex 0.157.1 shows its directory-trust
 * screen ("Trust this folder?") whenever the cwd has no `[projects."<cwd>"].trust_level`
 * (tui/src/lib.rs:2277-2279). A hive agent is launched non-interactively, so nobody can answer it:
 * the agent sits there and the first typed wake answers it wrongly. The product never seeded trust,
 * and under MUNDER_DEV the seed sanitiser drops every `[projects.*]` table (devIsolation.ts).
 *
 * The fix writes ONE entry into the AGENT'S OWN generated config.toml (never the user's file):
 * `[projects.'<exact agent cwd>'] trust_level = "trusted"`, after the DEV sanitise, so it holds in
 * DEV and Stable alike.
 *
 * How codex 0.157.1 keys a project (checked-out source, codex-rs):
 *   - the lookup (config/src/config_toml.rs:864-887 get_active_project, :894-907
 *     normalized_project_lookup_keys, :909-915, :917-932) tries the std-canonicalised cwd
 *     (`\\?\C:\...`) and then the cwd as given, each LOWERCASED on Windows, against each key
 *     lowercased: case-insensitive string equality, nothing else (no separator or trailing-slash
 *     normalisation). The cwd is dunce::simplified(current_dir) (core/src/config/mod.rs:3402-3431,
 *     utils/path-utils/src/lib.rs:54-56, :162-168).
 *   - codex's own writer (core/src/config/mod.rs:2319-2388) uses project_trust_key
 *     (config/src/loader/mod.rs:1370-1399): dunce::canonicalize(path), lowercased on Windows.
 *   - only the exact cwd or its git root is matched (config_toml.rs:863-887); a parent is never
 *     trusted by this entry (Jim C1: trust exactly the agent's own cwd).
 * So the key written is the resolved cwd without a `\\?\` prefix, lowercased on Windows.
 *
 * Trust also enables the cwd's project layer `<cwd>/.codex/config.toml` (config/src/loader/mod.rs
 * load_project_layers; precedence Project 25 < SessionFlags 30, config_layer_source.rs:33-51).
 * The agent's explicit `--sandbox` / `--ask-for-approval` still win (config_toml.rs:806
 * `sandbox_mode_override.or(self.sandbox_mode)`, core/src/config/mod.rs:3697-3699 the approval
 * override first), but other keys of that layer apply (sandbox_workspace_write, mcp_servers,
 * hooks, ...). codexProjectLayerRiskKeys names them so the spawn logs a warning row.
 */
import { existsSync, readFileSync } from 'node:fs';
import { posix, win32 } from 'node:path';

/**
 * THE switch. The Human's ruling for 1.1.75 ("go with the recommendations"): 'agent-cwd', i.e.
 * every Codex agent's own EXACT cwd, never a parent or a git root (Jim C1).
 *   'agent-cwd'        every Codex agent's own exact cwd (the ruling);
 *   'product-created'  only cwds the product made: <harnessHome>\worktrees\* and the hive's own
 *                      agent dirs (a user-picked cwd keeps meeting the trust screen);
 *   'off'              never (the pre-1.1.75 behaviour).
 */
export type CodexTrustSeedScope = 'agent-cwd' | 'product-created' | 'off';
export const CODEX_TRUST_SEED_SCOPE: CodexTrustSeedScope = 'agent-cwd';

export interface CodexTrustSeedContext {
  /** The harness home (HiveManager.getHome()); the hive lives in <it>\hive. */
  harnessHome: string | null;
  scope?: CodexTrustSeedScope;
  platform?: NodeJS.Platform;
}

const pathApi = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix);
const stripVerbatim = (p: string): string => p.replace(/^\\\\\?\\(?!UNC\\)/, '');
const inside = (child: string, parent: string, platform: NodeJS.Platform): boolean => {
  const P = pathApi(platform);
  const rel = P.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !P.isAbsolute(rel);
};

/** THE predicate: should this Codex agent's own config trust its cwd? Only an absolute cwd. */
export function shouldSeedCodexTrust(cwd: string | null | undefined, ctx: CodexTrustSeedContext): boolean {
  const scope = ctx.scope ?? CODEX_TRUST_SEED_SCOPE;
  const platform = ctx.platform ?? process.platform;
  if (scope === 'off' || typeof cwd !== 'string' || !cwd.trim()) return false;
  const P = pathApi(platform);
  if (!P.isAbsolute(stripVerbatim(cwd))) return false;
  if (scope === 'agent-cwd') return true;
  if (!ctx.harnessHome) return false;
  const c = P.resolve(stripVerbatim(cwd));
  const low = (s: string): string => (platform === 'win32' ? s.toLowerCase() : s);
  return [P.join(ctx.harnessHome, 'worktrees'), P.join(ctx.harnessHome, 'hive', 'agents')]
    .some((root) => inside(low(c), low(P.resolve(root)), platform));
}

/** The `[projects]` key codex 0.157.1 matches for this cwd (see the header). */
export function codexProjectTrustKey(cwd: string, platform: NodeJS.Platform = process.platform): string {
  const P = pathApi(platform);
  const resolved = P.resolve(stripVerbatim(cwd));
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Keys codex treats as the same project: case-insensitive on Windows, `\\?\` stripped. */
export function sameCodexProjectKey(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const n = (s: string): string => { const x = stripVerbatim(s); return platform === 'win32' ? x.toLowerCase() : x; };
  return n(a) === n(b);
}

// ── a minimal TOML key-path reader (headers and `key = ` lines only) ─────────────────────────

/** Parse a dotted TOML key path at the start of `s` (bare, "basic" or 'literal' parts).
 *  Returns the parts and where parsing stopped, or null when it is not a key path. */
function readKeyPath(s: string): { parts: string[]; rest: string } | null {
  const parts: string[] = [];
  let i = 0;
  const ws = (): void => { while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++; };
  for (;;) {
    ws();
    if (s[i] === '"') {
      let j = i + 1; let raw = '';
      while (j < s.length && s[j] !== '"') { if (s[j] === '\\') { raw += s[j] + (s[j + 1] ?? ''); j += 2; } else raw += s[j++]; }
      if (j >= s.length) return null;
      let v: string;
      try { v = JSON.parse(`"${raw.replace(/\\U([0-9A-Fa-f]{8})/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))}"`) as string; } catch { return null; }
      parts.push(v); i = j + 1;
    } else if (s[i] === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return null;
      parts.push(s.slice(i + 1, j)); i = j + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
      if (!m) return null;
      parts.push(m[0]); i += m[0].length;
    }
    ws();
    if (s[i] === '.') { i++; continue; }
    return { parts, rest: s.slice(i) };
  }
}

interface ProjectEntry { key: string; form: 'table' | 'dotted' | 'inline' | 'subtable'; hasTrust: boolean; headerLine: number }

/** Every project the config defines, in any TOML form, and whether `projects` is an inline table. */
export function codexConfigProjects(config: string): { entries: ProjectEntry[]; inlineProjects: boolean } {
  const lines = config.split(/\r?\n/);
  const entries: ProjectEntry[] = [];
  let inlineProjects = false;
  let table: string[] | null = [];   // [] = the root
  let current: ProjectEntry | null = null;
  lines.forEach((line, idx) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    if (t.startsWith('[[')) { table = null; current = null; return; }
    if (t.startsWith('[')) {
      const kp = readKeyPath(t.slice(1));
      current = null;
      if (!kp || !kp.rest.trimStart().startsWith(']')) { table = null; return; }
      table = kp.parts;
      if (table[0] === 'projects' && table.length === 2) { current = { key: table[1], form: 'table', hasTrust: false, headerLine: idx }; entries.push(current); }
      else if (table[0] === 'projects' && table.length > 2) entries.push({ key: table[1], form: 'subtable', hasTrust: false, headerLine: idx });
      return;
    }
    const kp = readKeyPath(t);
    if (!kp || !kp.rest.trimStart().startsWith('=')) return;
    const full = [...(table ?? ['?']), ...kp.parts];
    if (current && table && kp.parts.length === 1 && kp.parts[0] === 'trust_level') current.hasTrust = true;
    if (full[0] === 'projects' && full.length === 1) inlineProjects = true;
    else if (full[0] === 'projects' && full.length >= 2 && !(table && table[0] === 'projects' && table.length >= 2)) {
      entries.push({ key: full[1], form: full.length === 2 ? 'inline' : 'dotted', hasTrust: (full.length === 3 && full[2] === 'trust_level') || (full.length === 2 && /\btrust_level\s*=/.test(kp.rest)), headerLine: idx });
    }
  });
  return { entries, inlineProjects };
}

export type CodexTrustAction = 'added' | 'set' | 'kept' | 'kept-unmodifiable' | 'skipped-inline-projects';

/**
 * The agent's own config with its cwd trusted. Never a second table for a project codex treats as
 * the same (TOML forbids redefining a table): an existing `[projects.<same>]` table keeps its own
 * trust_level (the user's explicit choice, even "untrusted"), or gets `trust_level = "trusted"` if
 * it has none; a dotted/inline definition is left as is; an inline `projects = {...}` is left as
 * is (a table there would not parse). Otherwise one table is appended. Nothing else changes.
 */
export function withAgentTrust(config: string, cwd: string, platform: NodeJS.Platform = process.platform): { text: string; action: CodexTrustAction; key: string } {
  const key = codexProjectTrustKey(cwd, platform);
  const { entries, inlineProjects } = codexConfigProjects(config);
  const same = entries.filter((e) => sameCodexProjectKey(e.key, key, platform));
  if (same.length) {
    const tableEntry = same.find((e) => e.form === 'table');
    if (same.some((e) => e.hasTrust)) return { text: config, action: 'kept', key };
    if (tableEntry) {
      const eol = config.includes('\r\n') ? '\r\n' : '\n';
      const lines = config.split(/\r?\n/);
      lines.splice(tableEntry.headerLine + 1, 0, 'trust_level = "trusted" # munder-hive: the agent\'s own cwd');
      return { text: lines.join(eol), action: 'set', key };
    }
    return { text: config, action: 'kept-unmodifiable', key };
  }
  if (inlineProjects) return { text: config, action: 'skipped-inline-projects', key };
  const quoted = key.includes("'") || /[\r\n]/.test(key) ? JSON.stringify(key) : `'${key}'`;
  const sep = config === '' || config.endsWith('\n') ? '' : '\n';
  return { text: `${config}${sep}\n# munder-hive trust-seed: the agent's own cwd is trusted (no trust screen)\n[projects.${quoted}]\ntrust_level = "trusted"\n`, action: 'added', key };
}

/** Keys in <cwd>/.codex/config.toml (the project layer trust enables) that touch confinement or
 *  run commands. The agent's --sandbox / --ask-for-approval still win over the first two. */
const PROJECT_LAYER_RISK_KEYS = ['sandbox_mode', 'approval_policy', 'sandbox_workspace_write', 'permissions', 'default_permissions', 'mcp_servers', 'hooks'];
export function codexProjectLayerRiskKeys(cwd: string, fs: { existsSync: (p: string) => boolean; readFileSync: (p: string, e: 'utf8') => string } = { existsSync, readFileSync }, platform: NodeJS.Platform = process.platform): string[] {
  const P = pathApi(platform);
  const file = P.join(stripVerbatim(cwd), '.codex', 'config.toml');
  let text = '';
  try { if (!fs.existsSync(file)) return []; text = fs.readFileSync(file, 'utf8'); } catch { return ['(unreadable)']; }
  const found = new Set<string>();
  let table: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (t.startsWith('[')) { const kp = readKeyPath(t.replace(/^\[\[?/, '')); table = kp ? kp.parts : ['?']; if (PROJECT_LAYER_RISK_KEYS.includes(table[0])) found.add(table[0]); continue; }
    const kp = readKeyPath(t);
    if (!kp || !kp.rest.trimStart().startsWith('=')) continue;
    const top = table.length ? table[0] : kp.parts[0];
    if (PROJECT_LAYER_RISK_KEYS.includes(top)) found.add(top);
  }
  return [...found].sort();
}
